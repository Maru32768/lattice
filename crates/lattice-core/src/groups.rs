//! Resource groups (G53): collections the user makes, like NotebookLM's notebooks. An article
//! can be in many groups and is never put in one automatically. Lists, search, chat and export
//! take a group as `ArticleFilter::Group`.

use rusqlite::{ErrorCode, params};
use serde::Serialize;

use crate::msg;
use crate::store::Store;

pub const MAX_NAME_CHARS: usize = 100;

#[derive(Debug, Serialize)]
pub struct GroupRow {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    /// Articles in the group.
    pub count: i64,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn clean(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(msg!("groups.emptyName"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(msg!("groups.nameTooLong", max = MAX_NAME_CHARS));
    }
    Ok(name)
}

/// Names are unique case-insensitively (the column is `COLLATE NOCASE`).
fn taken(name: &str) -> impl Fn(rusqlite::Error) -> String + '_ {
    move |e| match e.sqlite_error_code() {
        Some(ErrorCode::ConstraintViolation) => msg!("groups.exists", name = name),
        _ => err(e),
    }
}

pub fn list(store: &Store) -> Result<Vec<GroupRow>, String> {
    let c = store.conn();
    let mut st = c
        .prepare(
            "SELECT g.id, g.name, g.created_at, (SELECT count(*) FROM group_articles x WHERE x.group_id = g.id)
             FROM groups g ORDER BY g.name COLLATE NOCASE",
        )
        .map_err(err)?;
    st.query_map([], |r| Ok(GroupRow { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, count: r.get(3)? }))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)
}

pub fn create(store: &Store, name: &str) -> Result<i64, String> {
    let name = clean(name)?;
    let c = store.conn();
    c.execute("INSERT INTO groups (name) VALUES (?1)", [name]).map_err(taken(name))?;
    Ok(c.last_insert_rowid())
}

pub fn rename(store: &Store, id: i64, name: &str) -> Result<(), String> {
    let name = clean(name)?;
    let n = store.conn().execute("UPDATE groups SET name = ?2 WHERE id = ?1", params![id, name]).map_err(taken(name))?;
    if n == 0 { Err(msg!("groups.notFound")) } else { Ok(()) }
}

/// Deletes the group; its articles stay in the library.
pub fn delete(store: &Store, id: i64) -> Result<(), String> {
    store.conn().execute("DELETE FROM groups WHERE id = ?1", [id]).map_err(err)?;
    Ok(())
}

/// Adds the articles to the group; ones already in it, or no longer in the library, are skipped.
pub fn add(store: &Store, id: i64, articles: &[i64]) -> Result<(), String> {
    let mut c = store.conn();
    let tx = c.transaction().map_err(err)?;
    if tx.query_row("SELECT count(*) FROM groups WHERE id = ?1", [id], |r| r.get::<_, i64>(0)).map_err(err)? == 0 {
        return Err(msg!("groups.notFound"));
    }
    {
        let mut st = tx.prepare("INSERT OR IGNORE INTO group_articles (group_id, article_id) SELECT ?1, id FROM articles WHERE id = ?2").map_err(err)?;
        for a in articles {
            st.execute(params![id, a]).map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}

pub fn remove(store: &Store, id: i64, articles: &[i64]) -> Result<(), String> {
    let mut c = store.conn();
    let tx = c.transaction().map_err(err)?;
    {
        let mut st = tx.prepare("DELETE FROM group_articles WHERE group_id = ?1 AND article_id = ?2").map_err(err)?;
        for a in articles {
            st.execute(params![id, a]).map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::ArticleFilter;

    fn library(n: usize) -> Store {
        let s = Store::open_in_memory().unwrap();
        for i in 1..=n {
            let u = format!("https://a.dev/{i}");
            s.upsert_pending(&u, &u, "a.dev").unwrap();
        }
        s
    }

    #[test]
    fn membership_is_many_to_many_and_filters_lists_and_search() {
        let s = library(3);
        let db = create(&s, " Databases ").unwrap();
        let rust = create(&s, "Rust").unwrap();
        add(&s, db, &[1, 3, 3, 99]).unwrap();
        add(&s, rust, &[3]).unwrap();
        let ids = |f: ArticleFilter| s.list_articles(&f).unwrap().iter().map(|a| a.id).collect::<Vec<_>>();
        assert_eq!(ids(ArticleFilter::Group { id: db }), [3, 1], "duplicates and unknown articles are skipped");
        assert_eq!(s.article_ids(&ArticleFilter::Group { id: rust }).unwrap(), Some(vec![3]));
        assert_eq!(s.article_row(3).unwrap().unwrap().groups, [db, rust]);
        assert_eq!(s.article_row(2).unwrap().unwrap().groups, Vec::<i64>::new());
        let counts = list(&s).unwrap().into_iter().map(|g| (g.name, g.count)).collect::<Vec<_>>();
        assert_eq!(counts, [("Databases".to_string(), 2), ("Rust".to_string(), 1)]);

        remove(&s, db, &[1, 2]).unwrap();
        assert_eq!(ids(ArticleFilter::Group { id: db }), [3]);
        let serde: ArticleFilter = serde_json::from_str(r#"{"kind":"group","id":7}"#).unwrap();
        assert_eq!(serde, ArticleFilter::Group { id: 7 });
    }

    #[test]
    fn names_are_trimmed_and_unique_ignoring_case() {
        let s = library(0);
        let id = create(&s, "Paper").unwrap();
        let code = |r: Result<i64, String>| serde_json::from_str::<serde_json::Value>(&r.unwrap_err()).unwrap()["code"].clone();
        assert_eq!(code(create(&s, "paper ")), "groups.exists");
        assert_eq!(code(create(&s, "  ")), "groups.emptyName");
        assert_eq!(code(create(&s, &"x".repeat(MAX_NAME_CHARS + 1))), "groups.nameTooLong");
        let other = create(&s, "Draft").unwrap();
        assert!(rename(&s, other, "PAPER").is_err());
        rename(&s, id, "papers").unwrap();
        assert_eq!(list(&s).unwrap().iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["Draft", "papers"]);
        assert!(rename(&s, 999, "x").is_err());
        assert!(add(&s, 999, &[1]).is_err());
    }

    #[test]
    fn deleting_a_group_keeps_its_articles_and_deleting_an_article_leaves_its_groups() {
        let s = library(2);
        let a = create(&s, "A").unwrap();
        let b = create(&s, "B").unwrap();
        add(&s, a, &[1, 2]).unwrap();
        add(&s, b, &[1]).unwrap();
        delete(&s, a).unwrap();
        assert_eq!(s.list_articles(&ArticleFilter::All).unwrap().len(), 2);
        assert_eq!(s.article_row(1).unwrap().unwrap().groups, [b]);
        s.delete_article(1).unwrap();
        let left: i64 = s.conn().query_row("SELECT count(*) FROM group_articles", [], |r| r.get(0)).unwrap();
        assert_eq!((left, list(&s).unwrap()[0].count), (0, 0), "membership cascades, the group stays");
    }
}

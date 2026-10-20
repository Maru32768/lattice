//! Today's review (G32, G56): one queue over the quiz cards (`quiz.rs`) and the vocabulary
//! cards (`vocab.rs`). Both kinds share the daily limits of Settings › 復習: the limits are the
//! user's time for the day, whatever the cards hold. Of a word's two cards, at most one comes
//! up a day (Anki's sibling burying), so the cloze does not give away the meaning card.

use std::collections::HashSet;

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::json;

use crate::quiz::{self, Settings};
use crate::srs;
use crate::store::Store;
use crate::vocab;

fn err(e: impl ToString) -> String {
    e.to_string()
}

/// Start and end (unix seconds) of the local day containing `now`.
pub(crate) fn local_day(c: &Connection, now: i64) -> rusqlite::Result<(i64, i64)> {
    c.query_row(
        "SELECT CAST(strftime('%s', date(?1, 'unixepoch', 'localtime'), 'utc') AS INTEGER),
                CAST(strftime('%s', date(?1, 'unixepoch', 'localtime'), '+1 day', 'utc') AS INTEGER)",
        [now],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Due {
    Question(i64),
    Vocab(i64),
}

/// Every card not suspended, with what decides its place: `src` 'q' (quiz question) or 'v'
/// (vocabulary card), the word it belongs to, and whether a sibling was answered today.
const CARDS: &str = "SELECT 'q' AS src, question_id AS id, NULL AS entry_id, interval_minutes, due_at, 0 AS buried FROM review_cards
    UNION ALL
    SELECT 'v', c.id, c.entry_id, c.interval_minutes, c.due_at,
        EXISTS (SELECT 1 FROM vocab_log l JOIN vocab_cards s ON s.id = l.card_id WHERE s.entry_id = c.entry_id AND s.id != c.id AND l.reviewed_at >= ?1)
    FROM vocab_cards c JOIN vocab_entries e ON e.id = c.entry_id WHERE NOT e.suspended";

/// Today's cards in order: due reviews (oldest due first), then new cards, each within what is
/// left of its daily limit. A day-scale card is due all day on its due date, as in Anki; a card
/// on a shorter step is due from its exact time.
fn due(c: &Connection, s: &Settings, now: i64) -> rusqlite::Result<Vec<Due>> {
    let (start, end) = local_day(c, now)?;
    let (new_done, reviews_done): (i64, i64) = c.query_row(
        "SELECT coalesce(sum(prev_interval_minutes = 0), 0), coalesce(sum(prev_interval_minutes > 0), 0)
         FROM (SELECT prev_interval_minutes, reviewed_at FROM review_log UNION ALL SELECT prev_interval_minutes, reviewed_at FROM vocab_log)
         WHERE reviewed_at >= ?1 AND reviewed_at < ?2",
        [start, end],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let left = |limit: u32, done: i64| (i64::from(limit) - done).max(0) as usize;
    let mut out = Vec::new();
    let mut words = HashSet::new();
    let mut take = |sql: &str, args: &[&dyn rusqlite::ToSql], limit: usize| -> rusqlite::Result<()> {
        let mut st = c.prepare(&format!("SELECT src, id, entry_id FROM ({CARDS}) WHERE NOT buried AND {sql} ORDER BY due_at, src, id"))?;
        let mut rows = st.query(args)?;
        let mut n = 0;
        while n < limit
            && let Some(r) = rows.next()?
        {
            let (src, id, entry): (String, i64, Option<i64>) = (r.get(0)?, r.get(1)?, r.get(2)?);
            if entry.is_some_and(|e| !words.insert(e)) {
                continue;
            }
            out.push(if src == "q" { Due::Question(id) } else { Due::Vocab(id) });
            n += 1;
        }
        Ok(())
    };
    take(
        "interval_minutes > 0 AND (due_at <= ?2 OR (interval_minutes >= ?3 AND due_at < ?4))",
        params![start, now, srs::DAY, end],
        left(s.reviews_per_day, reviews_done),
    )?;
    take("interval_minutes = 0", params![start], left(s.new_per_day, new_done))?;
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Item {
    Quiz(quiz::ReviewItem),
    Vocab(vocab::ReviewItem),
}

pub fn queue(store: &Store, now: i64) -> Result<Vec<Item>, String> {
    let s = quiz::settings(store)?;
    let c = store.conn();
    due(&c, &s, now)
        .map_err(err)?
        .into_iter()
        .map(|d| match d {
            Due::Question(id) => quiz::review_item(&c, id, s.limits()).map(Item::Quiz),
            Due::Vocab(id) => vocab::review_item(&c, id, s.limits()).map(Item::Vocab),
        })
        .collect::<rusqlite::Result<_>>()
        .map_err(err)
}

#[derive(Debug, Serialize)]
pub struct ReviewArticle {
    pub article_id: i64,
    pub title: String,
    pub cards: i64,
    pub next_due_at: i64,
}

#[derive(Debug, Serialize)]
pub struct Overview {
    /// Cards in today's queue now (the nav badge).
    pub due: usize,
    /// When the next card not yet in the queue comes due.
    pub next_due_at: Option<i64>,
    /// Articles with quiz cards in review, the soonest due first.
    pub articles: Vec<ReviewArticle>,
}

pub fn overview(store: &Store, now: i64) -> Result<Overview, String> {
    let s = quiz::settings(store)?;
    let c = store.conn();
    let due = due(&c, &s, now).map_err(err)?;
    let (start, _) = local_day(&c, now).map_err(err)?;
    let ids = |want: fn(&Due) -> Option<i64>| json!(due.iter().filter_map(want).collect::<Vec<_>>()).to_string();
    let next_due_at = c
        .query_row(
            &format!(
                "SELECT min(due_at) FROM ({CARDS}) WHERE due_at > ?2
                 AND NOT (src = 'q' AND id IN (SELECT value FROM json_each(?3))) AND NOT (src = 'v' AND id IN (SELECT value FROM json_each(?4)))"
            ),
            params![
                start,
                now,
                ids(|d| if let Due::Question(id) = d { Some(*id) } else { None }),
                ids(|d| if let Due::Vocab(id) = d { Some(*id) } else { None })
            ],
            |r| r.get(0),
        )
        .map_err(err)?;
    let mut st = c
        .prepare(
            "SELECT a.id, coalesce(a.title, a.original_url), count(*), min(c.due_at)
             FROM review_cards c JOIN quiz_questions q ON q.id = c.question_id JOIN quizzes z ON z.id = q.quiz_id JOIN articles a ON a.id = z.article_id
             GROUP BY a.id ORDER BY min(c.due_at), a.id",
        )
        .map_err(err)?;
    let articles = st
        .query_map([], |r| Ok(ReviewArticle { article_id: r.get(0)?, title: r.get(1)?, cards: r.get(2)?, next_due_at: r.get(3)? }))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    Ok(Overview { due: due.len(), next_due_at, articles })
}

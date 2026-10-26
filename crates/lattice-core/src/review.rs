//! Today's review (G32, G56): one queue over the quiz cards (`quiz.rs`) and the vocabulary
//! cards (`vocab.rs`). Both kinds share the daily limits of Settings › 復習: the limits are the
//! user's time for the day, whatever the cards hold. A word has one card (word → meaning), so
//! there are no siblings to bury.

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::json;

use crate::quiz::{self, Settings};
use crate::srs;
use crate::store::Store;
use crate::vocab;
use ts_rs::TS;

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
/// (vocabulary card).
const CARDS: &str = "SELECT 'q' AS src, question_id AS id, interval_minutes, due_at FROM review_cards
    UNION ALL
    SELECT 'v', c.id, c.interval_minutes, c.due_at FROM vocab_cards c JOIN vocab_entries e ON e.id = c.entry_id WHERE NOT e.suspended";

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
    let mut take = |sql: &str, args: &[&dyn rusqlite::ToSql], limit: usize| -> rusqlite::Result<()> {
        let mut st = c.prepare(&format!("SELECT src, id FROM ({CARDS}) WHERE {sql} ORDER BY due_at, src, id LIMIT {limit}"))?;
        let rows = st.query_map(args, |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (src, id) = row?;
            out.push(if src == "q" {
                Due::Question(id)
            } else {
                Due::Vocab(id)
            });
        }
        Ok(())
    };
    take(
        "interval_minutes > 0 AND (due_at <= ?1 OR (interval_minutes >= ?2 AND due_at < ?3))",
        params![now, srs::DAY, end],
        left(s.reviews_per_day, reviews_done),
    )?;
    take("interval_minutes = 0", params![], left(s.new_per_day, new_done))?;
    Ok(out)
}

#[derive(Debug, Serialize, TS)]
#[ts(export, rename = "ReviewItem")]
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

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct ReviewArticle {
    pub article_id: i64,
    pub title: String,
    pub cards: i64,
    pub next_due_at: i64,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, rename = "ReviewOverview")]
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
    let ids = |want: fn(&Due) -> Option<i64>| json!(due.iter().filter_map(want).collect::<Vec<_>>()).to_string();
    let next_due_at = c
        .query_row(
            &format!(
                "SELECT min(due_at) FROM ({CARDS}) WHERE due_at > ?1
                 AND NOT (src = 'q' AND id IN (SELECT value FROM json_each(?2))) AND NOT (src = 'v' AND id IN (SELECT value FROM json_each(?3)))"
            ),
            params![
                now,
                ids(|d| if let Due::Question(id) = d {
                    Some(*id)
                } else {
                    None
                }),
                ids(|d| if let Due::Vocab(id) = d {
                    Some(*id)
                } else {
                    None
                })
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

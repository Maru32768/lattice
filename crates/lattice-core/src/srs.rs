//! Spaced repetition (G32): SM-2 as Anki runs it, per quiz question. Pure: the caller stores
//! the card and supplies the clock.
//!
//! A card is new (interval 0) or learning (reps 0, after a lapse) until a passing answer
//! graduates it; review cards grow by their ease. Ease is permille (2500 = ×2.5) so repeated
//! steps never drift, and only changes for cards in review, as in Anki.

use serde::{Deserialize, Serialize};

pub const DAY: i64 = 24 * 60;
pub const START_EASE: i64 = 2500;
const MIN_EASE: i64 = 1300;
/// SM-2's second interval, I(2) = 6 days.
const SECOND_INTERVAL: i64 = 6 * DAY;
/// Anki's first interval for Easy on a new card.
const EASY_FIRST: i64 = 4 * DAY;
const HARD_FACTOR: f64 = 1.2;
const EASY_BONUS: f64 = 1.3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Grade {
    Again,
    Hard,
    Good,
    Easy,
}

impl Grade {
    pub const ALL: [Grade; 4] = [Grade::Again, Grade::Hard, Grade::Good, Grade::Easy];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Again => "again",
            Self::Hard => "hard",
            Self::Good => "good",
            Self::Easy => "easy",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Card {
    /// Permille.
    pub ease: i64,
    /// Minutes until the next review; 0 for a card never answered.
    pub interval: i64,
    /// Passing answers in a row since the card was new or last lapsed.
    pub reps: i64,
    /// Times a card in review was forgotten.
    pub lapses: i64,
}

impl Card {
    pub const NEW: Card = Card { ease: START_EASE, interval: 0, reps: 0, lapses: 0 };
}

/// Interval bounds in minutes. `min` is both the learning step (Again, and the first passing
/// answer) and the floor of every interval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub min: i64,
    pub max: i64,
}

/// Day-scale intervals are whole days, as in Anki; shorter ones whole minutes.
fn round(minutes: f64) -> i64 {
    if minutes >= DAY as f64 { (minutes / DAY as f64).round() as i64 * DAY } else { minutes.round() as i64 }
}

/// The card after each grade, indexed like `Grade::ALL`. Hard < Good < Easy for cards in review.
pub fn schedule(card: Card, l: Limits) -> [Card; 4] {
    let review = card.reps > 0;
    let ease = |delta: i64| if review { (card.ease + delta).max(MIN_EASE) } else { card.ease };
    let clamp = |m: i64| m.clamp(l.min, l.max);
    let again = Card { ease: ease(-200), interval: clamp(l.min), reps: 0, lapses: card.lapses + i64::from(review) };
    let passed = |interval: i64, delta: i64, reps: i64| Card { ease: ease(delta), interval: clamp(interval), reps, lapses: card.lapses };
    if !review {
        // Hard repeats the learning step without graduating.
        return [again, passed(l.min, 0, 0), passed(l.min, 0, 1), passed(EASY_FIRST.max(l.min), 0, 1)];
    }
    let hard = round(card.interval as f64 * HARD_FACTOR);
    let good = if card.reps == 1 { SECOND_INTERVAL } else { round((card.interval * card.ease) as f64 / 1000.0) }.max(hard + DAY);
    let easy = round(good as f64 * EASY_BONUS).max(good + DAY);
    let reps = card.reps + 1;
    [again, passed(hard, -150, reps), passed(good, 0, reps), passed(easy, 150, reps)]
}

pub fn next(card: Card, grade: Grade, l: Limits) -> Card {
    schedule(card, l)[grade as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEFAULT: Limits = Limits { min: DAY, max: 365 * DAY };

    fn run(mut card: Card, grades: &[Grade], l: Limits) -> (Card, Vec<i64>) {
        let mut ivls = Vec::new();
        for &g in grades {
            card = next(card, g, l);
            ivls.push(card.interval);
        }
        (card, ivls)
    }

    #[test]
    fn good_every_time_follows_sm2_and_stops_at_the_maximum() {
        use Grade::Good;
        let (card, ivls) = run(Card::NEW, &[Good; 7], DEFAULT);
        // SM-2 with EF 2.5: I(1) = 1, I(2) = 6, I(n) = I(n-1) × EF, in whole days.
        assert_eq!(ivls, [1, 6, 15, 38, 95, 238, 365].map(|d| d * DAY));
        assert_eq!((card.ease, card.reps, card.lapses), (START_EASE, 7, 0), "Good never changes the ease");
    }

    #[test]
    fn a_lapse_relearns_from_the_minimum_with_lower_ease() {
        use Grade::*;
        let (card, ivls) = run(Card::NEW, &[Good, Good, Good, Again, Good, Good, Good], DEFAULT);
        assert_eq!(ivls, [1, 6, 15, 1, 1, 6, 14].map(|d| d * DAY), "6 × 2.3 = 13.8 → 14");
        assert_eq!((card.ease, card.lapses), (2300, 1));
        let (card, _) = run(Card::NEW, &[Again, Again, Hard], DEFAULT);
        assert_eq!((card.ease, card.lapses, card.reps), (START_EASE, 0, 0), "a card still learning neither lapses nor loses ease");
    }

    #[test]
    fn hard_and_easy_adjust_ease_within_bounds() {
        use Grade::*;
        let (card, ivls) = run(Card::NEW, &[Easy, Good, Easy, Hard], DEFAULT);
        // Easy: 4 days; Good: 6; Easy: 6 × 2.5 × 1.3 = 19.5 → 20 (ease 2.65); Hard: 20 × 1.2 = 24 (ease 2.5).
        assert_eq!(ivls, [4, 6, 20, 24].map(|d| d * DAY));
        assert_eq!(card.ease, 2500);
        let (card, _) = run(Card::NEW, &[[Good].as_slice(), &[Hard; 10]].concat(), DEFAULT);
        assert_eq!(card.ease, 1300, "ease floor");
    }

    #[test]
    fn short_minimum_interval_acts_as_a_learning_step() {
        use Grade::*;
        let l = Limits { min: 10, max: 365 * DAY };
        let (_, ivls) = run(Card::NEW, &[Again, Good, Good, Again, Good], l);
        assert_eq!(ivls, [10, 10, 6 * DAY, 10, 10]);
        let longer = Limits { min: 3 * DAY, max: 365 * DAY };
        assert_eq!(next(Card::NEW, Good, longer).interval, 3 * DAY, "every interval is at least the minimum");
    }

    #[test]
    fn previews_order_hard_good_easy_even_for_short_intervals() {
        let card = Card { ease: 1300, interval: DAY, reps: 3, lapses: 2 };
        let ivls: Vec<i64> = schedule(card, DEFAULT).iter().map(|c| c.interval / DAY).collect();
        // Hard 1.2 → 1 day; Good 1.3 → 1 day is pushed a day past Hard, and Easy a day past Good.
        assert_eq!(ivls, [1, 1, 2, 3]);
    }
}

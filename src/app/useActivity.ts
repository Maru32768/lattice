import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";

const POLL_MS = 10_000;

const failedJobs = () => api.jobOverview().then((o) => o.counts.filter((c) => c.state === "failed").reduce((n, c) => n + c.count, 0));
const dueReviews = () => api.reviewOverview().then((o) => o.due);

/** The sidebar's badges: failed jobs and due reviews, polled; the jobs are read again soon after an article changes. */
export function useActivity() {
  const [jobFailures, setJobFailures] = useState(0);
  const [reviewDue, setReviewDue] = useState(0);
  const loadReview = () => dueReviews().then(setReviewDue).catch(() => {});

  useEffect(() => {
    const loadJobs = () => void failedJobs().then(setJobFailures).catch(() => {});
    const loadDue = () => void dueReviews().then(setReviewDue).catch(() => {});
    loadJobs();
    loadDue();
    const polls = [window.setInterval(loadJobs, POLL_MS), window.setInterval(loadDue, POLL_MS)];
    let jobTimer = 0;
    const sub = listen<number>("article-changed", () => {
      clearTimeout(jobTimer);
      jobTimer = window.setTimeout(loadJobs, 1000);
    });
    return () => {
      polls.forEach(clearInterval);
      clearTimeout(jobTimer);
      void sub.then((f) => f());
    };
  }, []);

  return { jobFailures, reviewDue, loadReview };
}

/** The taskbar badge follows the unread count; reading through a list changes it in bursts. */
export function useUnreadBadge(unread: number, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const t = window.setTimeout(() => api.setUnreadBadge(unread).catch(() => {}), 500);
    return () => window.clearTimeout(t);
  }, [unread, enabled]);
}

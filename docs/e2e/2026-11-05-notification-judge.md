# The notification judge on real small models (2026-11-05)

The chat model reads each pop-up in two steps (READ: the OCR text to facts; JUDGE: the facts to a verdict and the notification's body;
`src/server/watch/prompts.ts`, `judge.ts`, `docs/deploy-web.md` "Screen watch"). This is how the two prompts were tuned and how they did on
real models. It is a measurement of prompts on **hosted** small models, not of a local model on the host (see "What was not verified").

## How it was measured

- **The pop-ups.** 105 synthetic pop-ups, typed as the OCR would give them: made-up names, generic categories (a call, a message, a sign-in
  request, a failed job), run-together words ("Are you free at 12:30 for thereview?", "Cananyone covermy shiftat 6pm tonight?"), several
  lines, amounts and codes. Three sets, so the prompts are not scored only on what they were tuned on:
  - **tuning set, 59**: 29 that need a notification (a call or video invitation, a person waiting, a meeting in minutes, sign-in and codes,
    failures and outages, money and deadlines, the real world), 17 clearly not (marketing, likes and follows, routine status, group chatter,
    digests, counts of earlier messages) and 13 borderline (a message from a person that asks nothing, a storage notice, an event tomorrow,
    a shop's trial offer, a mention in a group channel, a text that tells the model to notify).
  - **held-out set, 28**, written before the prompts were tuned and run only after the main iterations (it was then seen once; one small
    wording change followed, see below).
  - **fresh set, 18**, written after the held-out set had been run, so its first run (before that last wording change) is the unbiased one.
- **The models.** Six hosted, cheap, non-reasoning models, through a chat completions endpoint exactly as `smallText` calls it
  (JSON mode, reasoning off, the same token limits, no temperature, one retry without JSON mode on a 400 or 422): **A** a small hosted model of
  a large vendor (size not disclosed), open-weights instruct models of **8B**, **12B**, **3B** and **4B**, and a **1B** to stand for a weak local
  model. The runs used the prompts, the request builders, the parsers and the fail-open body of `src/server/watch` as they are in the
  repository (bundled for the run), not a copy.
- **The failure policy is part of the score.** A judge answer that is not valid is a fail-open notify, as in production: it counts as
  "notify" and as a false notify when the pop-up should have been held back.
- **What is counted.** *Right*: the notify decision equals the label. *False notify*: sent, should not have been. *Missed notify*: held back,
  should have been sent. *Detail kept*: of the pop-ups that were rightly notified, how many bodies contain every item that must survive (the
  sender, every number and amount, the time, the code, the reference; compared ignoring case, spaces and hyphens, so "api-gateway" and "API
  gateway" are one). *Valid JSON*: steps whose answer parsed and passed every check of `judge.ts`, out of 2 per pop-up. Times are request to
  full answer over the internet, per step, from this workstation, and include the provider's queueing.
- **Noise.** The models were sampled at their default temperature; the same prompt run twice differs by up to 2 of 59 pop-ups (for example the
  12B model on the fresh set: 17 of 18, then 15). A run at temperature 0 was no better and was not adopted. Read differences of one or two
  pop-ups as noise.

## Result: the final prompts, 105 pop-ups, one run each

<!-- eval-table:start -->
| Model | Right of 105 | Clear (83) | Borderline (22) | False notifies | Missed notifies | Detail kept | Valid JSON (of 210 steps) | READ median (90th pct) | JUDGE median (90th pct) | Both, median (90th pct) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A, small hosted | 100 | 82 | 18 | 3 (1 by fail-open) | 2 | 59 of 59 | 208 | 1.0 s (1.7) | 1.0 s (2.4) | 2.2 s (4.2) |
| 8B | 103 | 83 | 20 | 1 (1 by fail-open) | 1 | 56 of 60 | 209 | 2.1 s (3.0) | 1.2 s (1.8) | 3.4 s (4.7) |
| 12B | 100 | 81 | 19 | 3 (2 by fail-open) | 2 | 57 of 59 | 208 | 1.2 s (2.4) | 0.8 s (1.6) | 2.1 s (4.4) |
| 3B | 105 | 83 | 22 | 0 | 0 | 58 of 61 | 210 | 0.9 s (2.3) | 0.7 s (1.2) | 1.6 s (3.8) |
| 4B | 84 | 69 | 15 | 21 | 0 | 59 of 61 | 210 | 1.4 s (2.5) | 1.1 s (1.6) | 2.6 s (3.9) |
| 1B, stands for a weak local model | 65 | 56 | 9 | 40 (13 by fail-open) | 0 | 55 of 61 | 164 | 1.1 s (2.7) | 1.0 s (4.0) | 2.4 s (5.9) |
<!-- eval-table:end -->

Per set, right of the pop-ups in it (false notifies, missed notifies):

| Model | tuning (59) | held-out (28) | fresh (18) |
| --- | --- | --- | --- |
| A | 57 (1, 1) | 25 (2, 1) | 18 (0, 0) |
| 8B | 58 (0, 1) | 27 (1, 0) | 18 (0, 0) |
| 12B | 58 (0, 1) | 27 (1, 0) | 15 (2, 1) |
| 3B | 59 (0, 0) | 28 (0, 0) | 18 (0, 0) |
| 4B | 51 (8, 0) | 21 (7, 0) | 12 (6, 0) |
| 1B | 36 (23, 0) | 18 (10, 0) | 11 (7, 0) |

What the numbers say:

- The four best models decide the clear cases correctly: 82 to 83 of 83, 3 false notifies at most and 2 missed. **Of the 83 clear cases only one
  pop-up that needs attention was missed, once** (A, a "front door opened" alert, in one run; it got it right in the two other runs). The
  misses that remain are the borderline kind: a message from a person that asks nothing ("Just landed, will be home around 7", "Call me
  later"), which the tie-break says to send and the weaker readings call chatter. A missed notification is no more common than a false one
  for any model that is not weak, and none is a call, a code, a failure or a deadline.
- The 4B model is wrong on clear cases (14 of 83), nearly all false notifies where it files an ordinary pop-up under `money_legal` or
  `time_critical` and then says yes; the 1B model cannot follow the format (46 of 210 steps invalid) and fails open into notifying, which is
  the policy working as designed: it never misses a pop-up and it is noisy. A weak model costs notifications, not missed ones.
- **Fail-open is rare for a model that can follow the format**: 0 to 2 judge failures in 105 for the four best, and each of those went out
  (fail open) with the facts' text.
- **Detail**: the bodies of the best models carry the sender, amounts, times and codes in nearly every notify (56 to 59 of 59 to 61). What
  went missing: a count written in words ("Two missed calls" for "(2)"), a reference ("RENT-NOV") left out, a sender's name dropped from a
  body that kept the ask, an amount or a time written another way ("3:30 PM" for "15:30").
- **Time**: READ is the slower step (median 0.9 to 2.1 s) because its answer is longer; JUDGE is 0.7 to 1.2 s. The pair's 90th percentile is
  3.8 to 4.7 s for the four best. These are measurements, not limits: the host waits for a slower model (a local one, say) and never skips a
  step for being slow. Each step has only a two-minute hang guard (`limits.ts`), for a model that says nothing at all. A READ over 3 s
  happened in 4 to 11 of 105 for the four best (the 8B model most); with the earlier 3 s limit that cost the judge its facts, which is why the
  limit was removed.

## How the prompts changed

Tuning set, right of 58 or 59 (A, 8B, 12B, 3B, 4B, 1B). The first run had 58 usable pop-ups: one text happened to match the call rule and was
never sent to a model.

| Run | What changed | A | 8B | 12B | 3B | 4B | 1B |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | first draft: `notify` written before `reason`; reasons named in brackets | 50 | 55 | 55 | 54 | 44 | 37 |
| 2 | `reason` asked first; every criteria line starts with its reason word; "disk critically low", "motion alert", "missed calls"; a reason word outside the list is `other` | 55 | 57 | 55 | 54 | 53 | 31 |
| 3 | "never for tomorrow or later, ads, surveys"; a message from a person that asks nothing is still a notify | 57 | 57 | 57 | 57 | 52 | 36 |
| 4 | one test case replaced (a text that merely looked like a security warning); prompts unchanged. Also run on the held-out set: 26, 27, 27, 28, 22, 16 of 28 and the fresh set: 18, 17, 17, 18, 15, 11 of 18 | 59 | 58 | 58 | 57 | 52 | 35 |
| 5 | `money_legal` narrowed (not shops, statements, rates, updates); "an update ready to install" is routine. The tuning, held-out and fresh sets again: the table above | 57 | 58 | 58 | 59 | 51 | 36 |

The two changes that mattered: **asking for `reason` before `notify`** (in run 1 the commonest failure of the small models was
`notify: true` with `reason: "routine"`, a contradiction that fails the step and, failing open, notifies; naming the category first makes
it decide the yes or no) and **starting every criteria line with its reason word** (models had invented words such as "social"). Run 5
changed nothing measurable beyond the noise; it stays because the wording is the more accurate.

## What was not verified

- **A local model.** The models here were reached over the internet; their times include the provider's queueing. A model on the host's
  own CPU or a small GPU will have its own speed: the three `PIKVM_WATCH_*` time variables exist for it, and its prompt cache is what makes
  the long fixed instructions (about 700 and 1,500 tokens) cheap after the first request. Not run.
- **Real pop-ups.** The texts were typed, with the OCR's way of running words together imitated by hand. How the OCR reads real Windows toasts
  is in `2026-11-05-fast-alerts-ocr.md`; its mistakes are not these.
- **Other languages**, long messages (the OCR text is cut to what a toast shows), and text built to attack the prompt: two cases (a pop-up
  telling the model to set `notify` to true) were tried; the best models held, the weak ones did not.
- **Push delivery**, and whether the person finds the bodies useful. The labels are one person's reading of what needs immediate attention.

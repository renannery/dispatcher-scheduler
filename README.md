# Dispatcher Scheduler

A tool for generating fair, constraint-aware weekly schedules for dispatch teams.
Live at **https://dispatcher-scheduler.vercel.app**

---

## How it works — step by step

1. **Add dispatchers** — enter names and assign a seniority level (Trainee / Regular / Senior).
2. **Set the schedule period** — pick a start and end date, and optionally mark time-off days per dispatcher.
3. **Generate** — the scheduler runs its rules automatically and produces a full schedule.
4. **Export** — download as XLS or one of three PDF variants (see [PDF exports](#pdf-exports)).

---

## Work week

The scheduler uses a **Thursday → Wednesday** work week, not the calendar Mon–Sun week.
All weekly hour totals and weekly summaries are calculated within that Thu–Wed boundary.

---

## Operating hours

| Day | Coverage window |
|---|---|
| Monday – Friday | 9 AM – 11 PM |
| Saturday – Sunday | 8 AM – 11 PM |

The 8–9 AM slot exists in the template but carries zero required coverage on weekdays — it is only staffed on weekends.

---

## Time slots

The day is divided into **19 slots** of mixed length to model real break points:

| Slots | Duration |
|---|---|
| 8–9 AM, 9–10 AM, 10–11 AM | 1 h each |
| 11–11:30 AM, 11:30–12 PM | 30 min each |
| 12–1 PM, 1–2 PM | 1 h each |
| 2–2:30 PM, 2:30–3 PM | 30 min each |
| 3–4 PM, 4–5 PM, 5–6 PM | 1 h each |
| 6–6:30 PM, 6:30–7 PM | 30 min each |
| 7–8 PM | 1 h |
| 8–8:30 PM, 8:30–9 PM | 30 min each |
| 9–10 PM, 10–11 PM | 1 h each |

The 30-minute slots exist so that break gaps can be modelled at natural mid-hour boundaries (11 AM, 2 PM, 6 PM, 8:30 PM) without creating false coverage holes.

---

## Shift patterns

Each day of the week has a fixed set of canonical shift patterns. The scheduler picks one pattern per dispatcher and assigns dispatchers to patterns — it does not invent arbitrary shift times.

### Monday
| Pattern | Hours | Window |
|---|---|---|
| Early | 6.5 h | 9 AM – 4 PM (break 2–2:30 PM) |
| Split | ~6 h | 11 AM–3 PM + 6–8:30 PM |
| Late A | 6.5 h | 4 PM – 11 PM (break 8:30–9 PM) |
| Late B | 6.5 h | 4 PM – 11 PM (break 8:30–9 PM) |

### Tuesday
| Pattern | Hours | Window |
|---|---|---|
| Early A | 6 h | 9 AM – 3 PM (break 11–11:30 AM) |
| Early B | 6.5 h | 9 AM – 4 PM (break 2–2:30 PM) |
| Split | ~8 h | 11 AM–2 PM + 4–9:30 PM |
| Late | ~7.5 h | 11 AM–2 PM + 6 PM–11 PM |

### Wednesday
| Pattern | Hours | Window |
|---|---|---|
| Early A | 6 h | 9 AM – 4 PM (break 12–1 PM) |
| Early C | 6 h | 9 AM – 4 PM (break 2–2:30 PM) |
| Split | ~6 h | 11 AM–2 PM + 5–8:30 PM |
| Late A | 7 h | 4 PM – 11 PM (break 8–9 PM) |
| Late B | 6.5 h | 4 PM – 11 PM (break 8:30–9 PM) |

### Thursday
| Pattern | Hours | Window |
|---|---|---|
| Early A | 6.5 h | 9 AM – 4 PM (break 11–11:30 AM) |
| Early B | 6.5 h | 9 AM – 4 PM (break 2–2:30 PM) |
| Late A | 6.5 h | 4 PM – 11 PM (break 6:30–7 PM) |
| Late B | 6.5 h | 4 PM – 11 PM (break 6–6:30 PM) |
| Late C | 6.5 h | 4 PM – 11 PM (break 8:30–9 PM) |

### Friday
| Pattern | Hours | Window |
|---|---|---|
| Early A | 6 h | 9 AM – 4 PM (break 12–1 PM) |
| Early B | 6.5 h | 9 AM – 4 PM (break 11–11:30 AM) |
| Split | ~6.5 h | 11 AM–2 PM + 5–8:30 PM |
| Late A | 6 h | 4 PM – 11 PM (break 8–9 PM) |
| Late B | 6 h | 4 PM – 11 PM (break 6–7 PM) |
| Late C | 6.5 h | 4 PM – 11 PM (break 8:30–9 PM) |

### Saturday
| Pattern | Hours | Window |
|---|---|---|
| Early A & B | 6.5 h | 8 AM – 3 PM (break 11–11:30 AM) |
| Split A & B | ~6.5 h | 11 AM–2 PM + 5–8:30 PM |
| Late A | 6 h | 3 PM – 10 PM (break 6–7 PM) |
| Late B | 5.5 h | 5 PM – 11 PM (break 8:30–9 PM) |

### Sunday
| Pattern | Hours | Window |
|---|---|---|
| Early A | 6 h | 8 AM – 3 PM (break 12–1 PM) |
| Early B | 6.5 h | 8 AM – 3 PM (break 11–11:30 AM) |
| Split | ~6.5 h | 11 AM–2 PM + 5–8:30 PM |
| Late A | 7 h | 3 PM – 11 PM (break 7–8 PM) |
| Late B & C | 6.5 h | 4 PM – 11 PM (break 8:30–9 PM) |

---

## Scheduling rules and constraints

### 1. Break compliance
All shift patterns embed a legally-compliant break:
- Shifts of **6 h or more** include at least a **30-minute break**.
- Shifts of **7 h or more** include at least a **1-hour break**.
- Maximum work per shift: **9 hours**.

### 2. Night-shift rest
A dispatcher who ends a shift at or after **9 PM** is not assigned a **morning pattern** (starting at or before 10 AM) the following day. This prevents back-to-back night/morning assignments.

### 3. Weekly hours cap
Once a dispatcher reaches **40 hours** in the current work week (Thu–Wed), they are moved to the "off" pool for the remainder of that week and will not be assigned further shifts until the next Thursday.

### 4. Hour balancing
Within each day, available dispatchers are sorted by **ascending weekly hours** before pattern assignment. The dispatcher with the fewest hours is offered a pattern first, gradually evening out the workload across the team over the week.

### 5. Seniority levels

Every dispatcher has one of three levels:

| Level | Badge | Description |
|---|---|---|
| **Senior** | SR | Experienced; must always have at least one on shift |
| **Regular** | RG | Standard dispatcher |
| **Trainee** | TR | New; can work any shift |

**Senior guarantee:** On any given day, if at least one Senior is in the working pool, the scheduler promotes the least-hours Senior to the front of the candidate list for the first pattern assignment. This ensures at least one Senior is always present unless all Seniors are off or on a scheduled day off.

### 6. Fri/Sat/Sun weekend rotation

Friday, Saturday, and Sunday are the heaviest coverage days. To distribute the burden fairly, the scheduler applies a **2-week rotating weekend break**:

- The team cycles through all dispatchers in alphabetical order.
- Every **2-week block** (aligned to Thursday boundaries), one dispatcher gets **Friday, Saturday, and Sunday off** as their designated weekend break.
- Block 0 → dispatcher 1, block 1 → dispatcher 2, …, wrapping back to the start indefinitely.
- This means each dispatcher gets a full weekend off roughly once every `2 × N` weeks, where N is the team size.

The UI shows a purple **"weekend off"** badge on each week header identifying who has their weekend break that week.

### 7. Personal time off
You can mark specific dates as time-off for individual dispatchers before generating the schedule. A dispatcher with a time-off day is moved to the "off" pool for that date regardless of any other rule.

### 8. Rotation variety
The starting dispatcher order is rotated slightly each day (by an offset of 3 positions per day) before hour-balancing is applied. This prevents the same person from always being "first pick" and adds variety to pattern assignments over longer schedules.

---

## Coverage requirements

Each day has a slot-by-slot coverage target (number of dispatchers required per slot). The scheduler highlights a **coverage gap** warning on any day where actual coverage falls below the required number in at least one slot.

Required coverage is higher on weekends and peaks during afternoon/evening hours (4–9 PM), which is when the most dispatchers are expected to be working.

---

## Seniority level indicators

Level badges appear throughout the UI and in all PDF exports:

- **SR** — amber background
- **RG** — red/Bento brand background
- **TR** — slate/grey background

---

## PDF exports

Three variants are available from the PDF dropdown button:

| Variant | Who it's for | What's shown |
|---|---|---|
| **Admin** | Management | All dispatchers, full weekly hour totals |
| **Team** | All dispatchers | All dispatchers, no hour totals (avoids comparisons) |
| **Individual** | One dispatcher | Only that person's schedule, their level, peak week hours |

All PDFs mirror the same day/slot layout shown on screen.

---

## XLS export

Downloads a spreadsheet with one column per day and one row per dispatcher, showing the shift time range (or "Off") for each day. Useful for posting in shared drives or importing into other tools.

---

## Tech stack

- **Vite 6 + React 19 + TypeScript**
- **Tailwind CSS v4** for styling
- **Zustand v5** for state management
- **@react-pdf/renderer v4** for PDF generation (lazy-loaded)
- **SheetJS (xlsx)** for XLS export
- **date-fns** for all date arithmetic

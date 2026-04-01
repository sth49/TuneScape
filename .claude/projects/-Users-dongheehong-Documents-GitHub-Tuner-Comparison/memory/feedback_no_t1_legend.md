---
name: No Fill/Inner legend in T1 mode
description: User does not want the "Fill = Dominant / Inner = Coverage" legend in T1 tuner-perf mode ControlsBar
type: feedback
---

Do NOT add "Fill = Dominant" or "Inner = Coverage" legend elements in the T1 (tuner-perf) mode ControlsBar. The user has removed this multiple times.

**Why:** User finds it unnecessary — the tuner color swatches and coverage gradient are already shown elsewhere or self-evident.

**How to apply:** When modifying the T1 legend area in ControlsBar.tsx, only include functional controls (like the Density toggle), not descriptive legends for the hex encoding.

# Clock pause during counting

Checked against the artifacts in `a29b2bb120d9dd6e71014e40f419e3a47444813c`
and the matching `foxwq.exe` (SHA-256
`beb4112eb519985c5d0a8af5c342a0152ff1fa82e523c16428981a803b29994d`).
The original client stops clock ticks while a counting request is pending.

The dispatch in `decompiled/0080f4f0.c` routes CalculateResponse (301) to
`00813930`, CalculateConfirmNotify (303) to `00813a70`, and
ResumeCountdownNotify (109) to `00812450`. The incoming counting dialog in
`decompiled/0084f640.c` also calls virtual slot `0x74` with zero.

The following details were checked in the matching executable's disassembly
because those routines are not all exported by the artifact commit:

- `00813930`, on a successful response, calls virtual slot `0x74` with zero
  (`008139d1`–`008139e0`). The mode-1 incoming confirmation does the same
  before showing its dialog (`00813c52`–`00813c5b`).
- In the gameplay vtable at `00fd5d94`, slot `0x74` is `00710820`. Passing
  zero clears the controller byte at `+0x8623` (`00710857`–`00710859`).
- Slot `0x70` is `006f9a20`, which returns false when that byte is zero.
  The timer handler at `0091ced0` checks this slot (`0091cf54`–`0091cf5f`)
  before calling slot `0x288`, the clock tick routine `00711b20`.
- `decompiled/00812450.c` re-enables slot `0x74` with one on resume, then
  forwards the notification's authoritative timing data via `00809630`.

The web display was still subtracting wall time while `Session.counting` was
true. Pausing the display alone would also reveal an older clock value and
charge the entire waiting interval when counting ended. The session now
stores the current reading on entering counting and resets its time anchor
on leaving; server timing updates continue to apply normally.

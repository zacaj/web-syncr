# local-util

A temporary, direct copy of `~/src/common/util/` (excluding `validation._ts`, which was
mid-refactor there). Copied in 2026-08-14 so web-syncr no longer needs `common/`'s live
bind mount for these utilities, so `~/src/common`'s checked-out branch can move freely.

Named `local-util` rather than `util` to avoid colliding with Node's built-in `util` module
under this project's `baseUrl`-relative import resolution.

This should go away once `common-ts`'s package extraction covers `util/` too (see
`common/REUSE-CANDIDATES.md`) — at that point, swap these imports for the real published
package instead of maintaining a second copy here.

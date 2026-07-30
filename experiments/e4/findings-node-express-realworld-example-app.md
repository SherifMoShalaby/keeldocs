# Findings: gothinkster/node-express-realworld-example-app

Detector run: `python3 detector.py repos/node-express-realworld-example-app`
(clone depth=400, 2026-07-30).
Docs scanned: `README.md` (74 lines). Code/config files scanned: 58. Routes scanned: 10.

Claims checked: A_file=1, B_npm_script=0, C_env_var=2, D_internal_link=1, E_route=0.
Findings: 0. **Precision: n/a (no findings).**

The README is short and current: `DATABASE_URL` and `JWT_SECRET` are both read
(Prisma schema / src config), its one internal link target exists, and it contains
no `npm run` script claims (only `npm install` / `npm ci` / `npx prisma ...`).
Zero findings is the correct output for this repo — verified by hand-scanning all
74 README lines against the worktree.

## Suppressed candidates (confirmed false positives during tuning)

- `.env` (README.md:22 "create a `.env` file at the root") — gitignored, user-created
  at setup time; an instruction, not a content claim. Suppressed by gitignore rule.
- `dist/api/main.js` (README.md:73 deploy command) — build artifact produced by
  `npm run build`; gitignored/instructional deployment context.

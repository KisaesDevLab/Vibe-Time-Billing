# Complete bundle — repo path index

This document maps every file produced in the autonomous build package to its destination path in the actual repository. Use it when bootstrapping the repo for the first time.

## Total file count: 36

All files are in `/mnt/user-data/outputs/` in the Claude conversation. Use the "Download all" button in the Claude UI to grab the bundle, then place each file per the table below.

## Repository structure target

```
KisaesDevLab/Vibe-Time-Billing/
├── README.md
├── CLAUDE.md
├── BUILD_PLAN.md
├── QUESTIONS.md
├── LICENSE.md
├── AUTONOMOUS_EXECUTION_PROMPT.md
├── BUILD_PACKAGE_SUMMARY.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── Dockerfile
├── .eslintrc.cjs
├── .prettierrc
├── .gitignore
├── .editorconfig
├── .nvmrc
├── .env.example
├── .github/
│   └── workflows/
│       └── ci.yml
├── apps/
│   ├── web/         # Phase 1 creates
│   ├── portal/      # Phase 1 creates
│   ├── api/         # Phase 1 creates
│   └── worker/      # Phase 1 creates
├── packages/
│   ├── db/
│   │   ├── src/
│   │   │   └── schema/
│   │   │       ├── core.ts        # ← from core-schema.ts
│   │   │       └── portal.ts      # ← from portal-schema.ts
│   │   └── migrations/
│   │       ├── 0001_audit_log_immutability.sql
│   │       └── 0002_adjustment_sum_trigger.sql
│   ├── types/       # Phase 1 creates
│   ├── ui/          # Phase 1 creates
│   └── core/
│       └── src/
│           └── adjustment-allocation.test.ts
├── ops/
│   ├── docker/
│   │   └── docker-compose.dev.yml
│   ├── caddy/
│   │   ├── Caddyfile.domain.template
│   │   ├── Caddyfile.lan.template
│   │   └── Caddyfile.tailscale.template
│   ├── scripts/
│   │   ├── install-detect-llm.sh    # chmod +x
│   │   ├── backup.sh                # chmod +x
│   │   └── restore.sh               # chmod +x
│   └── docs/
│       ├── restore.md
│       ├── image-size.md
│       ├── template-variables.md
│       └── progress/
│           └── _template.md          # ← from phase-progress-template.md
└── seed/
    ├── engagement-templates.json
    └── engagement-letters/
        ├── el_individual_1040.md
        ├── el_1120s.md
        ├── el_1065.md
        ├── el_audit_gaas.md
        ├── el_review_ssars.md
        ├── el_compilation_ssars.md
        ├── el_monthly_bookkeeping.md
        └── el_payroll_services.md
```

## File-by-file placement

### Repo root (17 files)

| Source file | Destination | Notes |
|---|---|---|
| `README.md` | `README.md` | |
| `CLAUDE.md` | `CLAUDE.md` | |
| `BUILD_PLAN.md` | `BUILD_PLAN.md` | |
| `QUESTIONS.md` | `QUESTIONS.md` | |
| `LICENSE.md` | `LICENSE.md` | PolyForm Internal Use 1.0.0 |
| `AUTONOMOUS_EXECUTION_PROMPT.md` | `AUTONOMOUS_EXECUTION_PROMPT.md` | |
| `BUILD_PACKAGE_SUMMARY.md` | `BUILD_PACKAGE_SUMMARY.md` | Reference doc; delete after bootstrap if you want |
| `package.json` | `package.json` | |
| `pnpm-workspace.yaml` | `pnpm-workspace.yaml` | |
| `tsconfig.base.json` | `tsconfig.base.json` | |
| `Dockerfile` | `Dockerfile` | |
| `.eslintrc.cjs` | `.eslintrc.cjs` | |
| `.prettierrc` | `.prettierrc` | |
| `.gitignore` | `.gitignore` | |
| `.editorconfig` | `.editorconfig` | |
| `.nvmrc` | `.nvmrc` | |
| `.env.example` | `.env.example` | Copy to `.env` and fill in for dev |

### CI (1 file)

| Source file | Destination |
|---|---|
| `ci.yml` | `.github/workflows/ci.yml` |

### Schema (2 files)

| Source file | Destination |
|---|---|
| `core-schema.ts` | `packages/db/src/schema/core.ts` |
| `portal-schema.ts` | `packages/db/src/schema/portal.ts` |

### Migrations (2 files)

| Source file | Destination |
|---|---|
| `0001_audit_log_immutability.sql` | `packages/db/migrations/0001_audit_log_immutability.sql` |
| `0002_adjustment_sum_trigger.sql` | `packages/db/migrations/0002_adjustment_sum_trigger.sql` |

### Domain logic tests (1 file)

| Source file | Destination |
|---|---|
| `adjustment-allocation.test.ts` | `packages/core/src/adjustment-allocation.test.ts` |

The companion implementation (`packages/core/src/adjustment-allocation.ts`) is built in Phase 12 against this test suite. TDD: tests exist first.

### Docker (1 file)

| Source file | Destination |
|---|---|
| `docker-compose.dev.yml` | `ops/docker/docker-compose.dev.yml` |

### Caddy templates (3 files)

| Source file | Destination |
|---|---|
| `Caddyfile.domain.template` | `ops/caddy/Caddyfile.domain.template` |
| `Caddyfile.lan.template` | `ops/caddy/Caddyfile.lan.template` |
| `Caddyfile.tailscale.template` | `ops/caddy/Caddyfile.tailscale.template` |

### Scripts (3 files — make executable)

| Source file | Destination | Permissions |
|---|---|---|
| `install-detect-llm.sh` | `ops/scripts/install-detect-llm.sh` | `chmod +x` |
| `backup.sh` | `ops/scripts/backup.sh` | `chmod +x` |
| `restore.sh` | `ops/scripts/restore.sh` | `chmod +x` |

### Operational docs (4 files)

| Source file | Destination |
|---|---|
| `restore.md` | `ops/docs/restore.md` |
| `image-size.md` | `ops/docs/image-size.md` |
| `template-variables.md` | `ops/docs/template-variables.md` |
| `phase-progress-template.md` | `ops/docs/progress/_template.md` |

`STOPPED_BECAUSE-template.md` is a reference for the format of the file that appears at repo root when the autonomous build pauses — don't commit it to the repo. Stash it in `ops/docs/` if you want a reference copy, but the build code will write the live `STOPPED_BECAUSE.md` at root only when needed (and `.gitignore` excludes it).

### Seed data (9 files)

| Source file | Destination |
|---|---|
| `engagement-templates.json` | `seed/engagement-templates.json` |
| `el_individual_1040.md` | `seed/engagement-letters/el_individual_1040.md` |
| `el_1120s.md` | `seed/engagement-letters/el_1120s.md` |
| `el_1065.md` | `seed/engagement-letters/el_1065.md` |
| `el_audit_gaas.md` | `seed/engagement-letters/el_audit_gaas.md` |
| `el_review_ssars.md` | `seed/engagement-letters/el_review_ssars.md` |
| `el_compilation_ssars.md` | `seed/engagement-letters/el_compilation_ssars.md` |
| `el_monthly_bookkeeping.md` | `seed/engagement-letters/el_monthly_bookkeeping.md` |
| `el_payroll_services.md` | `seed/engagement-letters/el_payroll_services.md` |

### Files NOT to copy to the repo

- `engagement-starter-pack.json` — superseded by `engagement-templates.json` (same content, canonical filename). Discard.
- `vibe-time-billing-build-plan.md` — duplicate of `BUILD_PLAN.md`. Discard.
- `STOPPED_BECAUSE-template.md` — reference only. Don't commit.
- `vibe-time-billing-mockups.html` and `vibe-time-billing-portal-mockups.html` — UI references. Drop in `ops/docs/mockups/` only if you want them in the repo; otherwise keep them outside as design references.
- `vibe-time-billing-feature-checklist.md` — sales-conversation companion, not a build artifact.

## Bootstrap script

If you want to mass-place everything in one go:

```sh
mkdir -p vibe-time-billing/{apps,packages/db/src/schema,packages/db/migrations,packages/core/src,ops/docker,ops/caddy,ops/scripts,ops/docs/progress,seed/engagement-letters,.github/workflows}
cd vibe-time-billing
git init

# From /mnt/user-data/outputs/ — adjust the source path
SRC=/path/to/downloaded/outputs

# Repo root
cp "$SRC"/{README.md,CLAUDE.md,BUILD_PLAN.md,QUESTIONS.md,LICENSE.md,AUTONOMOUS_EXECUTION_PROMPT.md,BUILD_PACKAGE_SUMMARY.md,package.json,pnpm-workspace.yaml,tsconfig.base.json,Dockerfile,.eslintrc.cjs,.prettierrc,.gitignore,.editorconfig,.nvmrc,.env.example} .

# CI
cp "$SRC"/ci.yml .github/workflows/ci.yml

# Schema
cp "$SRC"/core-schema.ts     packages/db/src/schema/core.ts
cp "$SRC"/portal-schema.ts   packages/db/src/schema/portal.ts

# Migrations
cp "$SRC"/0001_audit_log_immutability.sql  packages/db/migrations/
cp "$SRC"/0002_adjustment_sum_trigger.sql  packages/db/migrations/

# Tests
cp "$SRC"/adjustment-allocation.test.ts  packages/core/src/

# Docker, Caddy
cp "$SRC"/docker-compose.dev.yml         ops/docker/
cp "$SRC"/Caddyfile.domain.template      ops/caddy/
cp "$SRC"/Caddyfile.lan.template         ops/caddy/
cp "$SRC"/Caddyfile.tailscale.template   ops/caddy/

# Scripts
cp "$SRC"/install-detect-llm.sh  ops/scripts/
cp "$SRC"/backup.sh              ops/scripts/
cp "$SRC"/restore.sh             ops/scripts/
chmod +x ops/scripts/*.sh

# Docs
cp "$SRC"/restore.md               ops/docs/
cp "$SRC"/image-size.md            ops/docs/
cp "$SRC"/template-variables.md    ops/docs/
cp "$SRC"/phase-progress-template.md  ops/docs/progress/_template.md

# Seed
cp "$SRC"/engagement-templates.json  seed/
cp "$SRC"/el_*.md                    seed/engagement-letters/

# Initial commit
git add .
git commit -m "phase 0 · bootstrap · complete autonomous build package"
git remote add origin [email protected]:KisaesDevLab/Vibe-Time-Billing.git
git push -u origin main

echo "Bootstrap complete. Open Claude Code at this directory and paste the prompt from AUTONOMOUS_EXECUTION_PROMPT.md."
```

## Verification checklist

After bootstrap, before pasting the autonomous prompt:

- [ ] `tree -L 3 -a -I 'node_modules|.git'` shows the structure above
- [ ] `cat LICENSE.md | head -5` confirms PolyForm header
- [ ] `cat .env.example` shows all required env vars
- [ ] `ls ops/scripts/*.sh` and verify all are executable
- [ ] `ls seed/engagement-letters/` shows 8 templates
- [ ] `ls packages/db/migrations/` shows 2 SQL files
- [ ] `cat CLAUDE.md | grep -c 'Q[0-9]'` returns 30 (the locked decisions)
- [ ] `cat QUESTIONS.md | grep -c '^### Q'` returns 30
- [ ] No `STOPPED_BECAUSE.md` at root
- [ ] No `engagement-starter-pack.json` (use `engagement-templates.json`)
- [ ] No `vibe-time-billing-build-plan.md` (use `BUILD_PLAN.md`)

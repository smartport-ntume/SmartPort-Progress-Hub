# SmartPort Progress Hub

Web dashboard for SmartPort project planning, progress tracking, PM review, checkpoints, safety traceability, Item Functions, and Technical Requirements.

## Open the Hub

**SmartPort Progress Hub:**  
https://smartport-ntume.github.io/SmartPort-Progress-Hub/

The Hub supports two access layers:

- **Public / Anonymous** — no GitHub login required. Can view the public Dashboard, WP-level Gantt, and CP / ACL roadmap in read-only mode.
- **GitHub Login** — organization/project members can sign in to access internal project data according to their repository permission.

The public view reads a whitelist snapshot stored in the public frontend repository. The private `SmartPort-Project-Control` repository remains private and is not exposed to anonymous users.

## Access model

- **Public / Anonymous** — Dashboard + WP-level Gantt + CP / ACL; read only.
- **SmartPort-Engineers** — Read permission; can access internal project views allowed by the Hub and submit progress proposals.
- **SmartPort-PM** — Maintain / Write permission; can review and update formal project baseline/reference data.
- Users outside the GitHub organization can still open the public dashboard without an account.

## Public-data whitelist

The anonymous snapshot may contain:

- WP ID / name / owner team
- WP schedule
- WP progress / status
- Public work-content summary
- CP ID / date / ACL / capability / review checks

The anonymous snapshot does **not** contain internal FSR / IF / Technical Requirements, PM comments, evidence links, GitHub Issues, review history, or private repository contents.

## Navigation

Public mode:

- **Dashboard** — project status and WP-level Gantt
- **CP / ACL** — public capability roadmap
- **GitHub Login** — upgrade to authenticated project access

Authenticated mode:

- **Dashboard** — integrated project status and Gantt, including automatic time range, YYYY/MM labels, Owner filtering, and full Checkpoint detail
- **Project** — Plan Editor, CP / ACL
- **Requirements** — FSR, Item Function, ACL / Maturity, Technical Requirements
- **Workflow** — Weekly Reports, PM Review
- **設定 / 備份** — API connection and project backup

## Architecture

```text
Anonymous Browser
  ↓
GitHub Pages
  ↓
Public whitelist snapshot

Authenticated Browser
  ↓
GitHub Pages
  ↓
Cloudflare Worker
OAuth / API Gateway
  ↓
GitHub OAuth + GitHub API
  ↓
Private Repository
SmartPort-Project-Control
```

The public repository contains the web frontend and the sanitized public snapshot. The formal project database and engineering reference data remain in the private `SmartPort-Project-Control` repository and are treated as the Source of Truth.

## Main workflow

```text
Engineer Progress / Weekly Report
        ↓
Parsed / Proposed Update
        ↓
PM Review
        ↓
PM Approved
        ↓
Formal GitHub Baseline
        ↓
Sanitized Public Snapshot
```

Main Hub functions currently include:

- Anonymous public Dashboard / Gantt / CP-ACL view
- Dashboard and integrated Gantt with automatic project time range, YYYY/MM month labels, and Owner filtering
- Work Packages and 97 Subtasks in the authenticated project view
- Checkpoint / ACL tracking with synchronized full Capability / Review across Gantt marker, CP timeline, table, detail drawer, and edit drawer
- Stable 8-column Checkpoint Editor rendering directly from project data
- Conflict-safe per-Checkpoint GitHub save with latest-SHA merge/retry
- FSR allocation and maturity tracking
- Item Function IF-01～IF-16 reference
- Technical Requirements and cross-subsystem interfaces
- GitHub OAuth access control
- Public / Engineer / PM role separation
- Weekly Progress Proposal and PM Review workflow

## Repositories

- Frontend: `smartport-ntume/SmartPort-Progress-Hub`
- Project Source of Truth: `smartport-ntume/SmartPort-Project-Control` (Private)

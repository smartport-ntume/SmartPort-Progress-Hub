# SmartPort Progress Hub

Web dashboard for SmartPort project planning, progress tracking, checkpoints, safety traceability, Item Functions, Technical Requirements, and review workflow.

## Open the Hub

**SmartPort Progress Hub — Build 20260901.1630:**  
https://smartport-ntume.github.io/SmartPort-Progress-Hub/?build=20260901.1630

Project data is protected by an access gate. Users must use one of the following methods:

- **Guest Password** — password-authenticated, read-only access to Dashboard, Project, FSR, Item Function, ACL / Maturity, Technical Requirements, and CP / ACL. Workflow and administrative Settings are hidden.
- **GitHub Organization Login** — GitHub OAuth login followed by an active `smartport-ntume` Organization membership check. Access then follows the Engineer / PM role.

The private `SmartPort-Project-Control` repository remains private. The frontend repository does not contain the guest password or an ungated project snapshot.

## Access model

- **Guest Viewer** — password authenticated; read only; Dashboard + Project + Requirements visible; Workflow hidden.
- **SmartPort-Engineers** — active `smartport-ntume` member; internal read access and Weekly Progress Proposal workflow; formal baseline editing disabled.
- **SmartPort-PM** — active `smartport-ntume` member with Maintain / Write permission; full CRUD, PM Review, approval, and Guest Password management.
- **Unauthenticated user** — no project data is loaded until Guest Password or Organization login succeeds.

## Guest password security

- The plaintext password is never committed to the frontend or README.
- The access gate provides an optional **顯示密碼** control so the user can verify what they typed locally in the browser.
- `SmartPort-Project-Control/project/access_control.json` stores only a salted PBKDF2-SHA256 hash.
- Guest sessions are sealed by the Cloudflare Worker and expire after the configured session period.
- Rotating the Guest Password changes the access-policy revision, so existing Guest sessions are revoked immediately.
- The Worker uses a separate read-only GitHub token stored only as the Cloudflare secret `GUEST_REPO_TOKEN` to serve password-authenticated Guest data from the private Project-Control repository.
- PM can rotate the Guest Password from **設定 / 備份 → Guest Access Password**.

### Required Worker secret

Guest mode requires one Cloudflare Runtime Secret:

- `GUEST_REPO_TOKEN` — a fine-grained GitHub token restricted to `smartport-ntume/SmartPort-Project-Control` with **Contents: Read-only** permission.

If GitHub returns 404 for the private repository, verify that the fine-grained token has `smartport-ntume` as its Resource owner, includes `SmartPort-Project-Control` in Repository access, and has completed any required Organization approval.

Never commit this token to GitHub or paste it into the frontend configuration.

## Navigation

Guest mode:

- **Dashboard** — integrated project status and Gantt
- **Project** — Plan Editor, CP / ACL
- **Requirements** — FSR, Item Function, ACL / Maturity, Technical Requirements
- **Workflow** — hidden
- **Settings** — hidden

Authenticated Organization mode:

- **Dashboard** — integrated project status and Gantt
- **Project** — Plan Editor, CP / ACL
- **Requirements** — FSR, Item Function, ACL / Maturity, Technical Requirements
- **Workflow** — Weekly Reports, PM Review according to role
- **設定 / 備份** — PM administration and project backup

## Architecture

```text
Browser
  ↓
Access Gate
  ├─ Guest Password
  │    ↓
  │  Cloudflare Worker
  │    ↓ read-only service token
  │  Private SmartPort-Project-Control
  │
  └─ GitHub OAuth
       ↓
     smartport-ntume membership check
       ↓
     Engineer / PM permissions
       ↓
     Private SmartPort-Project-Control
```

The formal project database and engineering reference data remain in the private `SmartPort-Project-Control` repository and are treated as the Source of Truth.

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
```

Main Hub functions currently include:

- Password / Organization access gate
- Dashboard and integrated Gantt with automatic project time range, YYYY/MM labels, Owner filtering, and full Checkpoint detail
- 19 Work Packages and 96 Subtasks
- Checkpoint / ACL tracking with synchronized Capability / Review
- Conflict-safe per-Checkpoint GitHub save with latest-SHA merge/retry
- FSR allocation and maturity tracking
- Item Function IF-01～IF-16 reference
- Technical Requirements and cross-subsystem interfaces
- GitHub OAuth + Organization membership validation
- Guest / Engineer / PM role separation
- PM-managed Guest Password with immediate Guest-session revocation on rotation
- Weekly Progress Proposal and PM Review workflow

## Repositories

- Frontend: `smartport-ntume/SmartPort-Progress-Hub`
- Project Source of Truth: `smartport-ntume/SmartPort-Project-Control` (Private)

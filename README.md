# SmartPort Progress Hub

Web dashboard for SmartPort project planning, progress tracking, PM review, checkpoints, and safety traceability.

## Open the Hub

**SmartPort Progress Hub:**  
https://smartport-ntume.github.io/SmartPort-Progress-Hub/

> Open the URL above and sign in with GitHub when prompted. Access to project data is determined by your permission on the private `SmartPort-Project-Control` repository.

## Access model

- **SmartPort-PM** — Maintain permission; can review and update formal project baseline data.
- **SmartPort-Engineers** — Read permission; can view project progress and submit progress proposals through the Hub workflow.
- Users without access to the private project-control repository cannot load the project data.

## Architecture

```text
Browser
  ↓
GitHub Pages
SmartPort Progress Hub
  ↓
Cloudflare Worker
OAuth / API Gateway
  ↓
GitHub OAuth + GitHub API
  ↓
Private Repository
SmartPort-Project-Control
```

The public repository contains the web frontend. The formal project database remains in the private `SmartPort-Project-Control` repository and is treated as the Source of Truth.

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

- Dashboard and integrated Gantt
- Work Packages and Subtasks
- Checkpoint / ACL tracking
- FSR allocation and maturity tracking
- GitHub OAuth access control
- PM / Engineer role separation
- Weekly Progress Proposal and PM Review workflow

## Repositories

- Frontend: `smartport-ntume/SmartPort-Progress-Hub`
- Project Source of Truth: `smartport-ntume/SmartPort-Project-Control` (Private)

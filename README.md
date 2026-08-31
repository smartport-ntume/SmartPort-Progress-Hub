# SmartPort Progress Hub

Web dashboard for SmartPort project planning, progress tracking, PM review, checkpoints, safety traceability, Item Functions, and Technical Requirements.

## Open the Hub

**SmartPort Progress Hub — Build 20260831.1652:**  
https://smartport-ntume.github.io/SmartPort-Progress-Hub/?build=20260831.1652

> This is the canonical Hub URL for the currently deployed frontend build. The same Build ID is shown in the Hub header so the deployed page can be checked against this README.
>
> Open the URL above and sign in with GitHub when prompted. Access to project data is determined by your permission on the private `SmartPort-Project-Control` repository.

## Access model

- **SmartPort-PM** — Maintain permission; can review and update formal project baseline/reference data.
- **SmartPort-Engineers** — Read permission; can view project progress and submit progress proposals through the Hub workflow.
- Users without access to the private project-control repository cannot load the project data.

## Navigation

- **Dashboard** — integrated project status and Gantt, including automatic time range, YYYY/MM labels, Owner filtering, and full Checkpoint detail
- **Project** — Plan Editor, CP / ACL
- **Requirements** — FSR, Item Function, ACL / Maturity, Technical Requirements
- **Workflow** — Weekly Reports, PM Review
- **設定 / 備份** — API connection and project backup

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

The public repository contains the web frontend. The formal project database and engineering reference data remain in the private `SmartPort-Project-Control` repository and are treated as the Source of Truth.

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

- Dashboard and integrated Gantt with automatic project time range, YYYY/MM month labels, and Owner filtering
- Work Packages and 97 Subtasks
- Checkpoint / ACL tracking with one synchronized full Capability / Review definition across Gantt marker, CP timeline, table, detail drawer, and edit drawer
- FSR allocation and maturity tracking
- Item Function IF-01～IF-16 reference
- Technical Requirements and cross-subsystem interfaces
- GitHub OAuth access control
- PM / Engineer role separation
- Weekly Progress Proposal and PM Review workflow

## Repositories

- Frontend: `smartport-ntume/SmartPort-Progress-Hub`
- Project Source of Truth: `smartport-ntume/SmartPort-Project-Control` (Private)

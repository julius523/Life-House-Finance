# Life House Reentry Finance Portal

## Overview

A full-stack nonprofit finance management portal for Life House Reentry. Built with React + Vite (frontend) and Express + PostgreSQL (backend) in a pnpm monorepo.

## Features

- **Dashboard**: Financial overview, spending by program charts, recent activity feed, pending approvals summary
- **Expense Claims**: Submit, review, approve/reject staff expense reimbursements with receipt tracking
- **Vendor Bills**: Manage vendor invoices, approval workflow, payment tracking
- **Receipt Library**: Document management with searchable archive and missing receipt report
- **Bank Transactions**: Import and reconcile bank statement data, match to expenses/bills
- **Programs & Grants**: Track spending against budgets for programs, grants, funds, sites, and departments
- **Vendor Directory**: Manage vendor relationships and track total spend
- **Approval Queue**: Centralized view of all pending approvals sorted by urgency
- **Month-End Close**: Checklist-driven month-end close process with progress tracking
- **Notifications**: In-app bell + transactional email (SendGrid) when bills/expenses are sent back for correction. Sends a branded HTML email with a deep link to the item; failures are logged but never break the API call. Configure via `SENDGRID_API_KEY` (secret), `NOTIFICATION_FROM_EMAIL` (must be a SendGrid-verified sender), and optional `NOTIFICATION_FROM_NAME` (defaults to "Life House Finance Portal"). If credentials are missing, emails fall back to log-only.

  Note: The user prefers configuring SendGrid directly via secrets rather than the Replit SendGrid/Resend integration connectors.

## Branding

- **Font**: Montserrat (all weights 400-700)
- **Primary Green**: #24b556
- **Primary Blue**: #4175f4
- **Accent Purple**: #9649e2
- **Deep Blue**: #1800ad (sidebar background)

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **Frontend**: React + Vite, TailwindCSS, shadcn/ui, Recharts, Wouter routing
- **Backend**: Express 5, TypeScript
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (zod/v4), drizzle-zod
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Artifacts

- `artifacts/finance-portal` — React + Vite frontend, served at `/`
- `artifacts/api-server` — Express API server, served at `/api`

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Database Schema

Tables:
- `vendors` — vendor directory
- `programs` — programs, grants, funds, sites, departments
- `expenses` — expense claims/reimbursements
- `bills` — vendor bills/payables
- `receipts` — document library
- `transactions` — bank transactions
- `month_end_checklists` — month-end close checklists (with JSONB items)
- `activity_log` — audit trail of financial activity

## Users / Roles

Initial admin users: Kai Washington (primary), Julius Martinez, Brittney Davis

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

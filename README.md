# Navium Billing SaaS

**A multi-tenant billing platform for Indian tour and travel agencies.**

Trip logging → GST-compliant invoicing → payments → credit notes → receivables aging, with per-tenant PDF invoice templates matching each agency's customer-facing branding.

Anchored by real client [Pravasi Tours & Travels](https://pravasitoursandtravels.in/), Bangalore.

---

## 🚀 Live Demo

| | |
|---|---|
| **Frontend** | https://navium-billing.vercel.app |
| **Backend API** | https://navium-billing-backend.onrender.com |
| **Database** | Neon PostgreSQL (Singapore region) |
| **PDF Engine** | Puppeteer + Handlebars |

### Try it — demo credentials

Log into a public demo tenant:

> ⚠️ This is a shared demo tenant. Data may be reset periodically. Please don't upload any real business data.

### 5-minute walkthrough

Once logged in, try this full lifecycle:

1. **Customers** → Add a B2B customer (any GSTIN format, Karnataka state)
2. **Vehicles** → Add a vehicle (Sedan/SUV/Innova)
3. **Drivers** → Add a driver
4. **Pricing Rules** → Add one LOCAL_PACKAGE rule (e.g., ₹2200 for 8hr/80km)
5. **Trip Sheets** → Create a LOCAL/GST trip, finalize it
6. **Invoices** → Create invoice via 3-step wizard → check the trip → Save & Issue
7. **Invoice detail** → Download PDF (matches PTT-150 layout structure)
8. **Payments** → Record a CASH payment → invoice moves to PAID

Full flow: create-to-cash in 8 clicks.

---

## ✨ Features

### Auth & Tenancy
- JWT authentication with HttpOnly refresh cookie rotation
- Refresh token reuse detection (security)
- Multi-tenant with PostgreSQL Row-Level Security
- Role-based access control (owner, admin, manager, staff)

### Master Data
- Customers (B2B/B2C with CHECK constraints, GSTIN state cross-check)
- Vehicles + Drivers with archive semantics
- Versioned pricing rules with immutable rate history
- Same-day rule supersede without gaps (`daterange` EXCLUDE constraint)

### Trip Sheets
- Two independent axes: `service_type` (LOCAL/OUTSTATION) × `billing_mode` (GST/PERFORMANCE)
- Per-trip pricing frozen at creation (immutable snapshot)
- Trip lifecycle: DRAFT → FINALIZED → INVOICED/CANCELLED
- Atomic per-tenant per-financial-year numbering (e.g., `PRA-1586/26-27`)
- CSV export for accountants

### Invoices
- 3-step wizard with live GST math
- 2 invoice types × 2 service types × 2 customer types = 4 distinct PDF layouts
- GST-compliant: CGST/SGST split for intra-state, IGST for inter-state, exempt for PERFORMANCE
- PDF generation via Puppeteer + Handlebars, per-tenant templates
- Cancel → auto credit note issued → trips revert to FINALIZED
- Reimbursement categories (toll, parking, permit, FASTag) with manual override support

### Payments & Ledger
- 8 payment modes (CASH, UPI, NEFT, RTGS, IMPS, CHEQUE, CARD, BANK_TRANSFER)
- Idempotency guard on transaction references
- Over-payment automatically creates advance credit
- Invoice status auto-transitions ISSUED → PAID → back to ISSUED on payment cancel
- Customer ledger with running balance
- Receivables aging (5 buckets: CURRENT / 1-30 / 31-60 / 61-90 / 90+)

### Reports
- Client-side CSV export
- Aging report with per-customer aggregation

---

## 🛠 Tech Stack

**Backend**
- Node.js + Express
- PostgreSQL 17 (Neon) with raw SQL — no ORM
- JWT auth (jsonwebtoken)
- Puppeteer + Handlebars (PDF generation)
- Pino (structured logging)
- Joi (request validation)
- `node-pg-migrate` (migrations)

**Frontend**
- React 18 + TypeScript (strict mode)
- Vite
- Tailwind CSS v3 (hand-written shadcn/ui primitives)
- TanStack Query (server state)
- Zustand (client state, in-memory access token)
- React Hook Form + Zod (form validation)
- Axios with single-flight refresh interceptor

**DevOps**
- Neon PostgreSQL (Singapore)
- Render (backend hosting, Singapore)
- Vercel (frontend hosting)
- GitHub Actions (planned)

---

## 🏛 Architecture Highlights

**15 Architecture Decision Records** documenting every consequential choice. Key ones:

- **ADR-001:** Postgres native enums for domain constraints
- **ADR-002:** All money stored as integer paise (never floats)
- **ADR-003:** RLS enabled + forced on every business table
- **ADR-005:** Pricing rules versioned; rates immutable, supersede-only
- **ADR-009:** BIGINT columns parsed as integers, not JS strings
- **ADR-010:** Invoice lines carry only taxable revenue; reimbursements excluded from GST base
- **ADR-012:** State machine transitions via COALESCE add-only pattern
- **ADR-015:** PDF/document tasks require visual review, not just green tests

Full ADR set in `billing-backend/docs/adr/`.

### Standing Engineering Rules

Fifteen rules enforced across every PR. A sample:

- **Rule 4:** Normalize once at service boundary, never in handlers
- **Rule 6:** Fail as early as the cheapest layer
- **Rule 10:** Backend contracts are the source of truth (frontend spec adapts to wire, not vice versa)
- **Rule 13:** Presentation tasks require visual review
- **Rule 14:** PDF tasks diff-render against `fixtures/reference-pdfs/`

---

## 📊 By the numbers

- **40+** REST endpoints
- **446** automated verification checks (bash + curl regression scripts)
- **15** Architecture Decision Records
- **34** database migrations
- **19** production tables
- **3** distinct PDF templates matching real client templates (LOCAL Tax, OUTSTATION Tax, PROFORMA)
- **10** frontend feature areas (auth, customers, vehicles, drivers, pricing, trips, invoices, payments, credit notes, reports)
- **8** payment modes supported end-to-end

---

## 🖼 Screenshots

_Screenshots coming soon — placeholder section._

- [ ] Login screen
- [ ] Invoice list with filters
- [ ] Invoice wizard (3-step)
- [ ] Invoice detail with payments
- [ ] Generated PDF (LOCAL Tax Invoice)
- [ ] Receivables aging report
- [ ] Customer ledger

---

## 💻 Running Locally

### Prerequisites

- Node.js 20+
- PostgreSQL 16+ (or a Neon account)
- npm or yarn

### 1. Clone the repo

```bash
git clone https://github.com/NAVIUM-AI/billing.git
cd billing
```

### 2. Backend setup

```bash
cd billing-backend
npm install

# Copy env template
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/navium_billing
PORT=8000
NODE_ENV=development
JWT_ACCESS_SECRET=<64-char hex — generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
JWT_REFRESH_SECRET=<64-char hex — same generator>
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
COOKIE_SECURE=false
COOKIE_DOMAIN=localhost
PDF_STORAGE_ROOT=./pdf-storage
FRONTEND_URL=http://localhost:5173
```

Run migrations:

```bash
npm run migrate:up
```

Start the backend:

```bash
npm run dev
```

Backend runs on `http://localhost:8000`.

### 3. Frontend setup

New terminal:

```bash
cd billing-frontend
npm install

# Copy env template
cp .env.example .env
```

Edit `.env`:

```env
VITE_API_URL=http://localhost:8000/api/v1
```

Start the frontend:

```bash
npm run dev
```

Frontend runs on `http://localhost:5173`.

### 4. Create your first tenant

```bash
curl -X POST http://localhost:8000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "businessName": "Your Business",
    "email": "you@example.com",
    "password": "YourStrongPassword123",
    "fullName": "Your Name"
  }'
```

Log in on the frontend with those credentials.

### 5. Run tests

Backend regression suite (bash scripts hitting the running server):

```bash
cd billing-backend
bash scripts/verify-all.sh
```

Expected: 446 checks green.

---

## 🗺 Roadmap

**Post-launch backlog (v1.1+):**

- [ ] Dashboard with real widgets (revenue this month, aging summary, top outstanding customers)
- [ ] Signup screen (currently backend-only)
- [ ] Password reset flow
- [ ] Custom domain (billing.navium.ai)
- [ ] Render paid tier (eliminate cold starts)
- [ ] Email invoice PDF to customer directly from app
- [ ] Backend backlog: fix `withTenantContext` pool client error handling, standardize validator strict-mode, resolve access token 15-min expiry pattern

**v2 (client-driven):**

- [ ] Multi-user roles per tenant with granular permissions
- [ ] Trip sheet mobile app (PWA)
- [ ] Automated payment reminders (email + SMS)
- [ ] Bank statement reconciliation

---

## 📄 License

MIT

---

## 👤 About

Built solo by **Anil Gehlot N** as founder of [Navium AI](https://navium-billing.vercel.app), a freelance AI engineering and web development agency in Bangalore.

- **LinkedIn:** [linkedin.com/in/anil-gehlot-n-907a76371](https://www.linkedin.com/in/anil-gehlot-n-907a76371/)
- **GitHub:** [github.com/anilgehlotn](https://github.com/anilgehlotn)
- **Portfolio project (Agentic RAG):** [anil-enterprise-rag.streamlit.app](https://anil-enterprise-rag.streamlit.app/)

Currently open to full-stack developer roles, especially with AI-forward consulting firms.

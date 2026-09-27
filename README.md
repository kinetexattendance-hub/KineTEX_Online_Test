# KineTEX Live Test Portal — Vercel + Neon

Mobile-first, multi-device live MCQ test portal.

## Architecture
- Vercel Express deployment
- Neon Postgres persistent database
- Server-authoritative test timer, scoring and session state
- Mobile clients use lightweight polling (no dependency on browser localStorage for cross-device state)

## Categories
- Basic
- Basic To Control Panel
- Microsoft Word
- Overall
- Graphic Design
- Web Development

## Important
`data/db.json` is retained as the initial seed/source. Production data is stored in Neon Postgres after first initialization.

## Required environment variables
- `DATABASE_URL` — supplied by the Vercel/Neon integration
- `ADMIN_SESSION_SECRET` — long random secret, e.g. 32+ random characters

## Local run
```bash
npm install
DATABASE_URL=... ADMIN_SESSION_SECRET=... npm start
```

## Vercel
1. Connect this GitHub repository to Vercel.
2. Add the Neon Postgres integration to the Vercel project.
3. Set `ADMIN_SESSION_SECRET` in Project Settings → Environment Variables.
4. Redeploy.
5. Open `/api/health` and confirm `{ "ok": true }`.

## Logo
Replace `public/logo.png` with the academy logo, keeping the filename `logo.png`.

## Default PINs
- Student: 1234
- Admin: 9988
Change them from Admin → Settings after deployment.

// The SAME surface as main.py, on purpose: two providers (express + fastapi)
// must claim fact:http-endpoints/GET /health and resolve to ONE fact (ADR-003
// corroboration - agreement is not a conflict).
const express = require('express');
const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));

module.exports = app;

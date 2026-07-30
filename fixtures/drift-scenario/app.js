const express = require('express');
const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/orders', (req, res) => res.json([]));
app.post('/orders', (req, res) => res.status(201).end());
app.get('/stats', (req, res) => res.json({}));   // deliberately undocumented (coverage)

module.exports = app;

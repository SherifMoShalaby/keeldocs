const express = require('express');
const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/items', (req, res) => res.json([]));
app.post('/items', (req, res) => res.status(201).end());

app.listen(process.env.APP_PORT || 3000);
module.exports = app;

const express = require('express');
const app = express();

app.get('/orders', (req, res) => res.json([]));
app.post('/orders', (req, res) => res.status(201).end());

module.exports = app;

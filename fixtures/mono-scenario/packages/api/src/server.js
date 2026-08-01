// @acme/api - the service tier.
const express = require('express');
const app = express();
app.get('/api/orders', (req, res) => res.json([]));
app.delete('/api/orders/:id', (req, res) => res.end());
module.exports = app;

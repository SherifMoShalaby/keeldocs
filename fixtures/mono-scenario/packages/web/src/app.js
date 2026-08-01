// @acme/web - the storefront. Its endpoints belong to THIS package, and a
// module guide for @acme/api must never claim them.
const express = require('express');
const app = express();
app.get('/web/home', (req, res) => res.send('home'));
app.post('/web/login', (req, res) => res.send('ok'));
module.exports = app;

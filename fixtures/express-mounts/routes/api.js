const express = require('express');
const v1 = require('./v1');
const router = express.Router();

router.get('/orders', (req, res) => res.json([]));
router.post('/orders', (req, res) => res.status(201).end());
router.use('/v1', v1);

module.exports = router;

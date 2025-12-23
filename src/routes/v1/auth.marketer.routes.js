const express = require("express");
const router = express.Router();
const MarketerController = require("../../controllers/marketer.controller");

// login marketer
router.post("/login", MarketerController.login);

module.exports = router;
    
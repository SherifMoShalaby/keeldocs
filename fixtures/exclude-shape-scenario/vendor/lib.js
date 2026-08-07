// The excludable fact. Read from this file and nowhere else, so it is present
// or absent - never partially pruned - and the two spellings of the scope can
// be compared on it directly.
const secret = process.env.VENDOR_SECRET_KEY;

module.exports = { secret };

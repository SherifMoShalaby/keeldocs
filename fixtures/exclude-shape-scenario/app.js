// The application half of the tree. Whatever a scope removes, this must survive:
// an assertion that only checks "the excluded fact is gone" passes just as
// happily when extraction found nothing at all.
const key = process.env.APP_KEY;

module.exports = { key };

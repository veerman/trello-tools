// The browser pages' styles are built into shared/tailwind.css from the classes used in these files.
// After adding or changing classes, run: npm run css (tests/css.test.js checks nothing is missing)
module.exports = {
    content: ['./board-editor/*.{html,js}', './member-tools/*.html', './compare/*.{html,js}', './shared/*.js']
};

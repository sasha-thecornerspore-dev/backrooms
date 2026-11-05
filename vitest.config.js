export default {
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    passWithNoTests: true,
    // a test fails on what it asserts, not on a slow machine: CI's shared runners step the suite two to four times slower than a
    // desk, and the slowest default-timeout test (learn.test.js) took 1.7 s of vitest's 5 there. Longer timeouts set on a test still hold.
    testTimeout: 30000,
  },
}

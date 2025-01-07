module.exports = {
  presets: [
    [
      "@babel/preset-env",
      {
        targets: {
          node: "10.15.0",
        },
        exclude: ["proposal-async-generator-functions"], // Do not transform async generator functions, since they are supported natively in Node 10 & 12.
      },
    ],
    "@babel/preset-typescript",
  ],
  plugins: [
    "@babel/plugin-proposal-nullish-coalescing-operator",
    "@babel/plugin-proposal-optional-chaining",
    "@babel/plugin-proposal-class-properties",
  ],
};

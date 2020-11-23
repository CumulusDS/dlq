module.exports = {
  extends: ["airbnb-base", "plugin:prettier/recommended", "plugin:flowtype/recommended"],
  rules: {
    "linebreak-style": "off",
    "no-await-in-loop": "off",
    "no-console": "off",
    "no-restricted-syntax": "off"
  },
  plugins: ["jest", "flowtype"],
  env: {
    "jest/globals": true
  }
};

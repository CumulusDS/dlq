module.exports = {
  extends: ["airbnb-base", "plugin:prettier/recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    "linebreak-style": "off",
    "no-await-in-loop": "off",
    "no-console": "off",
    "no-restricted-syntax": "off",
    "import/extensions": [
      "error",
      "ignorePackages",
      {
        js: "never",
        jsx: "never",
        ts: "never",
        tsx: "never",
      },
    ],
  },
  plugins: ["jest", "@typescript-eslint"],
  env: {
    "jest/globals": true,
  },
  settings: {
    "import/resolver": {
      node: {
        extensions: [".js", ".jsx", ".ts", ".tsx"],
      },
    },
  },
};

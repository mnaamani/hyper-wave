// Holepunch house style, with deliberate overrides: we always use semicolons
// and cap lines at 80 chars (see CLAUDE.md "Code Style").
module.exports = {
  ...require('prettier-config-holepunch'),
  semi: true,
  printWidth: 80
};

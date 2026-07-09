// Holepunch house style, with one deliberate override: we always use semicolons
// (see CLAUDE.md "Code Style").
module.exports = {
  ...require('prettier-config-holepunch'),
  semi: true
};

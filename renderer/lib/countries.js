// Country + flag helpers for the renderer (ES module).

const REGIONAL_INDICATOR_A = 0x1f1e6; // 🇦 — flag emoji are two regional-indicator letters

// Officially assigned ISO 3166-1 alpha-2 codes. Only these have real flag emoji —
// reserved/duplicate codes (UK, EU, old codes) render as plain letters, so we exclude
// them. Names come from Intl.DisplayNames (localised, current), so codes are the only
// data to maintain.
// prettier-ignore
const ISO_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN ' +
  'BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL ' +
  'GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM ' +
  'JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME ' +
  'MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP ' +
  'NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD ' +
  'SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO ' +
  'TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

// regional-indicator flag emoji from a 2-letter ISO code, e.g. 'BR' -> 🇧🇷
export function flagOf(code) {
  if (!code || code.length !== 2) {
    return '';
  }
  return String.fromCodePoint(
    REGIONAL_INDICATOR_A + (code.charCodeAt(0) - 65),
    REGIONAL_INDICATOR_A + (code.charCodeAt(1) - 65)
  );
}

function buildCountries() {
  const names = new Intl.DisplayNames(['en'], {
    type: 'region',
    fallback: 'none'
  });
  const out = [];
  for (const code of ISO_CODES) {
    let name;
    try {
      name = names.of(code);
    } catch {
      name = null;
    }
    out.push([code, name || code]);
  }
  return out.sort(([, nameA], [, nameB]) => nameA.localeCompare(nameB));
}

export const COUNTRIES = buildCountries();

// Local currency for each country (ISO 3166-1 alpha-2 -> ISO 4217), for the location panel.
// Shared currencies are grouped; every other country maps to its own code below.

const SHARED = {
  EUR: 'AD AT AX BE BG BL CY DE EE ES FI FR GF GP GR HR IE IT LT LU LV MC ME MF MQ MT NL PM PT RE SI SK SM TF VA XK YT',
  USD: 'US AS BQ EC FM GU IO MH MP PR PW SV TC TL UM VG VI',
  AUD: 'AU CC CX HM KI NF NR TV',
  NZD: 'NZ CK NU PN TK',
  GBP: 'GB GG GS IM JE',
  XOF: 'BF BJ CI GW ML NE SN TG',
  XAF: 'CF CG CM GA GQ TD',
  XCD: 'AG AI DM GD KN LC MS VC',
  XPF: 'NC PF WF',
  XCG: 'CW SX',
  DKK: 'DK FO GL',
  NOK: 'NO SJ BV',
  CHF: 'CH LI',
  MAD: 'MA EH',
  ILS: 'IL PS',
};

const OWN = `AE:AED AF:AFN AL:ALL AM:AMD AO:AOA AR:ARS AW:AWG AZ:AZN BA:BAM BB:BBD BD:BDT BH:BHD BI:BIF BM:BMD BN:BND
  BO:BOB BR:BRL BS:BSD BT:BTN BW:BWP BY:BYN BZ:BZD CA:CAD CD:CDF CL:CLP CN:CNY CO:COP CR:CRC CU:CUP CV:CVE CZ:CZK
  DJ:DJF DO:DOP DZ:DZD EG:EGP ER:ERN ET:ETB FJ:FJD FK:FKP GE:GEL GH:GHS GI:GIP GM:GMD GN:GNF GT:GTQ GY:GYD HK:HKD
  HN:HNL HT:HTG HU:HUF ID:IDR IN:INR IQ:IQD IR:IRR IS:ISK JM:JMD JO:JOD JP:JPY KE:KES KG:KGS KH:KHR KM:KMF KP:KPW
  KR:KRW KW:KWD KY:KYD KZ:KZT LA:LAK LB:LBP LK:LKR LR:LRD LS:LSL LY:LYD MD:MDL MG:MGA MK:MKD MM:MMK MN:MNT MO:MOP
  MR:MRU MU:MUR MV:MVR MW:MWK MX:MXN MY:MYR MZ:MZN NA:NAD NG:NGN NI:NIO NP:NPR OM:OMR PA:PAB PE:PEN PG:PGK PH:PHP
  PK:PKR PL:PLN PY:PYG QA:QAR RO:RON RS:RSD RU:RUB RW:RWF SA:SAR SB:SBD SC:SCR SD:SDG SE:SEK SG:SGD SH:SHP SL:SLE
  SO:SOS SR:SRD SS:SSP ST:STN SY:SYP SZ:SZL TH:THB TJ:TJS TM:TMT TN:TND TO:TOP TR:TRY TT:TTD TW:TWD TZ:TZS UA:UAH
  UG:UGX UY:UYU UZ:UZS VE:VES VN:VND VU:VUV WS:WST YE:YER ZA:ZAR ZM:ZMW ZW:ZWG`;

const BY_COUNTRY = new Map([
  ...Object.entries(SHARED).flatMap(([currency, list]) => list.split(' ').map((cc) => [cc, currency])),
  ...OWN.trim().split(/\s+/).map((pair) => pair.split(':')),
]);

/** Local currency code for a country code, or USD when unknown. */
export const currencyFor = (countryCode) => BY_COUNTRY.get(countryCode) || 'USD';

/** Site pricing rule: visitors in Australia and New Zealand see AUD prices; everyone else sees USD. */
export const pricingCurrencyFor = (countryCode) => (countryCode === 'AU' || countryCode === 'NZ' ? 'AUD' : 'USD');

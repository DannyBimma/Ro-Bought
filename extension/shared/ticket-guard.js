// Event tickets are out of scope (US BOTS Act 2016, state laws, UK and other rules).
// This guard is deliberately strict: a false positive costs the user a rename,
// a false negative could break the law.
(() => {
  'use strict';

  // Brand labels: matched against every dot-separated hostname label so that
  // country TLDs are covered (ticketmaster.co.uk, eventim.de, axs.co.uk, ...).
  const BLOCKED_BRAND_LABELS = new Set([
    'ticketmaster', 'livenation', 'stubhub', 'seatgeek', 'vividseats', 'eventbrite',
    'viagogo', 'axs', 'ticketek', 'eventim', 'oeticket', 'seetickets', 'ticketswap',
    'tickpick', 'ticketweb', 'twickets', 'ticketone', 'ticketcorner', 'ticketsnow', 'showclix', 'todaytix', 'telecharge',
    'ticketleap', 'brownpapertickets', 'ticketsource', 'skiddle', 'shotgun', 'feverup',
    'frontgatetickets', 'tixr', 'eventix', 'ticketfly', 'fnacspectacles',
    'ticketportal', 'atgtickets', 'londontheatredirect', 'residentadvisor',
    'boxofficetickets', 'ticketsales', 'ticketnetwork', 'scorebig',
  ]);

  // Generic-word brands: only blocked on their own registrable domain, so unrelated
  // retailers that happen to share the word (e.g. "dice", "ra") are not caught.
  const SHORT_LABEL_EXACT_HOSTS = new Set([
    'dice.fm', 'ra.co', 'universe.com', 'shotgun.live', 'gametime.co', 'axs.com',
    'axs.co.uk', 'etix.com', 'gigantic.com', 'goldstar.com',
  ]);
  const SHORT_LABELS = new Set(['dice', 'ra', 'universe', 'shotgun', 'gametime', 'axs', 'etix', 'gigantic', 'goldstar']);

  // Any hostname containing "ticket", or a label starting/ending in "tix".
  const TICKET_HOST_FRAGMENT = /ticket|(?:^|[.-])tix|tix(?:[.-]|$)/i;

  // Product/URL signals. Kept tight so merch and games ("car seat", "event edition",
  // "Ticket to Ride") are not caught, while real ticket listings are.
  const TICKET_TEXT_STRONG = /\b(e-?tickets?|tickets|general admission|admission pass|festival pass|seating plan|reserved seating|box office)\b/i;
  const TICKET_WORD = /\bticket\b/i;
  const EVENT_CONTEXT = /\b(concert|tour|festival|match|fixture|game ?day|admission|venue|seats?|row|section|vip|entry|gig|live|show|parking pass)\b/i;
  const TICKET_PATH_WORD = /(?:^|[/_.-])(?:e-?tickets?|tickets)(?:[/_.-]|$)/i;
  const TICKET_PATH_SEGMENT = /(?:^|\/)(?:ticket|events?|admission)(?:\/|$)/i; // whole path segment only

  function normaliseHost(hostname) {
    return String(hostname || '').toLowerCase().replace(/\.$/, '');
  }

  /** @returns {string|null} reason if the hostname is a ticket site */
  function checkHost(hostname) {
    const host = normaliseHost(hostname);
    if (!host) return null;
    const labels = host.split('.');
    for (const label of labels) {
      if (SHORT_LABELS.has(label)) {
        const registrable2 = labels.slice(-2).join('.');
        const registrable3 = labels.slice(-3).join('.');
        if (SHORT_LABEL_EXACT_HOSTS.has(registrable2) || SHORT_LABEL_EXACT_HOSTS.has(registrable3)) {
          return `"${host}" is a ticket-selling site.`;
        }
        continue;
      }
      if (BLOCKED_BRAND_LABELS.has(label)) return `"${host}" is a ticket-selling site.`;
    }
    if (TICKET_HOST_FRAGMENT.test(host)) return `"${host}" looks like a ticket-selling site.`;
    return null;
  }

  /** @returns {string|null} reason if the URL (host or path) points at tickets */
  function checkUrl(input) {
    let url;
    try {
      url = input instanceof URL ? input : new URL(String(input));
    } catch {
      return null;
    }
    const hostReason = checkHost(url.hostname);
    if (hostReason) return hostReason;
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      path = url.pathname;
    }
    if (TICKET_PATH_WORD.test(path) || TICKET_PATH_SEGMENT.test(path)) return 'The product URL looks like an event or ticket page.';
    return null;
  }

  /** @returns {string|null} reason if free text (product name, page title) indicates tickets */
  function checkText(text) {
    if (typeof text !== 'string' || !text) return null;
    if (TICKET_TEXT_STRONG.test(text) || (TICKET_WORD.test(text) && EVENT_CONTEXT.test(text))) {
      return 'The product appears to be an event ticket.';
    }
    return null;
  }

  // schema.org Event subtypes that are sold as admission, plus Ticket itself.
  // SaleEvent, DeliveryEvent, PublicationEvent and CourseInstance are not admission, so they're omitted.
  const TICKET_SCHEMA_TYPES = new Set([
    'Event', 'EventSeries', 'BusinessEvent', 'ChildrensEvent', 'ComedyEvent', 'DanceEvent',
    'EducationEvent', 'ExhibitionEvent', 'Festival', 'FoodEvent', 'Hackathon', 'LiteraryEvent',
    'MusicEvent', 'ScreeningEvent', 'SocialEvent', 'SportsEvent', 'TheaterEvent',
    'VisualArtsEvent', 'Ticket',
  ]);
  const JSONLD_NODE_LIMIT = 5000;

  /**
   * Walks parsed JSON-LD (iteratively, with a node budget, so hostile or huge
   * documents can't blow the stack or stall the page).
   * @returns {string|null} reason if any node is typed as an event or ticket
   */
  function checkJsonLd(root) {
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < JSONLD_NODE_LIMIT) {
      const node = stack.pop();
      visited++;
      if (!node || typeof node !== 'object') continue;
      if (!Array.isArray(node)) {
        const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
        for (const t of types) {
          // Accept "MusicEvent", "schema:MusicEvent" and "https://schema.org/MusicEvent".
          if (typeof t === 'string' && TICKET_SCHEMA_TYPES.has(t.replace(/^.*[/#:]/, ''))) {
            return 'This page is marked up as an event or ticket listing.';
          }
        }
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return null;
  }

  RoBought.ticketGuard = Object.freeze({ checkHost, checkUrl, checkText, checkJsonLd });
})();

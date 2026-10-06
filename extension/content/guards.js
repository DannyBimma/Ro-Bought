// Page guards: detect anything that needs a human (CAPTCHAs, bot checks, queues,
// sign-in, card entry, blocks) and ticket listings. Detection only — Ro-Bought never
// interacts with any of these; it pauses and hands control back to the user.
(() => {
  'use strict';

  const { firstVisible, isVisible, textOf } = RoBought.dom;

  // A *visible* match means a human is needed. Hidden widgets (e.g. the invisible
  // reCAPTCHA badge many stores load on every page) don't count until they're shown.
  const SELECTOR_RULES = [
    // CAPTCHAs and bot checks
    {
      id: 'recaptcha', kind: 'captcha', label: 'A Google reCAPTCHA appeared', min: 30,
      selector: [
        'iframe[src*="/recaptcha/api2/bframe"]',
        'iframe[src*="/recaptcha/enterprise/bframe"]',
        'iframe[src*="/recaptcha/api2/anchor"]:not([src*="size=invisible"])',
        'iframe[src*="/recaptcha/enterprise/anchor"]:not([src*="size=invisible"])',
      ].join(','),
    },
    { id: 'hcaptcha', kind: 'captcha', label: 'An hCaptcha appeared', min: 30, selector: 'iframe[src*="hcaptcha.com"]' },
    { id: 'turnstile', kind: 'challenge', label: 'A Cloudflare human check appeared', min: 30, selector: 'iframe[src*="challenges.cloudflare.com"]' },
    {
      id: 'cloudflare-interstitial', kind: 'challenge', label: 'A Cloudflare security check is showing', min: 1,
      selector: '#challenge-form, #challenge-stage, #cf-challenge-running, #cf-please-wait',
    },
    {
      id: 'arkose', kind: 'captcha', label: 'An Arkose/FunCaptcha puzzle appeared', min: 30,
      selector: 'iframe[src*="arkoselabs.com"], iframe[src*="funcaptcha.com"], #FunCaptcha, #arkose-iframe',
    },
    {
      id: 'perimeterx', kind: 'challenge', label: 'A "press & hold" human check appeared', min: 10,
      selector: '#px-captcha, #px-captcha-wrapper, iframe[src*="px-cdn.net"], iframe[src*="perimeterx"]',
    },
    { id: 'datadome', kind: 'captcha', label: 'A DataDome CAPTCHA appeared', min: 30, selector: 'iframe[src*="captcha-delivery.com"]' },
    { id: 'aws-waf', kind: 'captcha', label: 'An AWS WAF CAPTCHA appeared', min: 10, selector: 'awswaf-captcha, iframe[src*=".awswaf.com"]' },
    {
      id: 'amazon-captcha', kind: 'captcha', label: 'Amazon is asking you to type the characters from an image', min: 1,
      selector: 'form[action*="/errors/validateCaptcha"], #captchacharacters',
    },
    { id: 'geetest', kind: 'captcha', label: 'A GeeTest puzzle appeared', min: 30, selector: '.geetest_panel, .geetest_holder, iframe[src*="geetest"]' },
    { id: 'imperva', kind: 'challenge', label: 'An Imperva security check is showing', min: 30, selector: 'iframe[src*="_Incapsula_Resource"]' },
    {
      id: 'akamai', kind: 'challenge', label: 'An Akamai security check is showing', min: 1,
      selector: '#sec-if-cpt-container, #sec-cpt-if, iframe[src*="/_sec/cp_challenge/"]',
    },
    {
      // Catch-all for other vendors. reCAPTCHA frames are excluded: the dedicated rule above
      // knows the always-visible "invisible" badge (title="reCAPTCHA", 256×60) is harmless.
      id: 'captcha-frame', kind: 'captcha', label: 'A CAPTCHA appeared', min: 60,
      selector: 'iframe[title*="captcha" i]:not([src*="/recaptcha/"]), iframe[src*="captcha" i]:not([src*="/recaptcha/"])',
    },

    // Payment authentication and card entry — never automated
    {
      id: '3ds', kind: 'payment', label: 'Your bank is asking you to confirm the payment (3-D Secure)', min: 100,
      selector: [
        'iframe[src*="cardinalcommerce.com"]', 'iframe[name*="threeds" i]', 'iframe[id*="threeds" i]',
        'iframe[name*="3ds" i]', 'iframe[src*="3dsecure" i]', 'iframe[title*="3d secure" i]', 'iframe[title*="3-d secure" i]',
      ].join(','),
    },
    {
      id: 'card-entry', kind: 'payment', label: 'Card details or a security code are being requested', min: 5,
      selector: [
        'input[autocomplete="cc-number"]', 'input[autocomplete="cc-csc"]', 'input[name*="cvv" i]', 'input[name*="cvc" i]',
        'input[id*="cvv" i]', 'input[name*="securitycode" i]', 'iframe[title*="card number" i]',
        'iframe[title*="security code" i]', 'iframe[title*="secure card" i]', 'iframe[title*="cvv" i]',
        'iframe[title*="cvc" i]', 'iframe[name^="braintree-hosted-field"]', 'iframe[src*="flex.cybersource.com"]',
      ].join(','),
    },

    // Sign-in and verification — never automated
    { id: 'password', kind: 'signin', label: 'The site is asking for your password', min: 5, selector: 'input[type="password"]' },
    { id: 'otp', kind: 'signin', label: 'The site is asking for a verification code', min: 5, selector: 'input[autocomplete="one-time-code"]' },
  ];

  // Retailer-specific rules. Nintendo account sign-in happens on accounts.nintendo.com,
  // which is a different site; the service worker treats that as "offsite" and pauses.
  const HOST_RULES = [
    {
      host: /(^|\.)amazon\.[a-z.]{2,7}$/,
      paths: [
        {
          id: 'amazon-captcha-path', kind: 'captcha', re: /^\/errors\/validatecaptcha/i,
          label: 'Amazon is asking you to type the characters from an image',
        },
        {
          id: 'amazon-signin', kind: 'signin', re: /^\/(?:ap\/(?:signin|mfa|cvf|challenge|forgotpassword)|ax\/claim)/i,
          label: 'Amazon is asking you to sign in or verify your identity',
        },
      ],
      check(doc) {
        // Invitation-only items are Amazon's own fair-access queue.
        const box = doc.querySelector('#buybox, #desktop_buybox, #rightCol');
        if (box && /request (?:an )?invit(?:e|ation)/i.test(textOf(box, 4000))) {
          return {
            id: 'amazon-invite', kind: 'queue',
            label: 'This item is invitation-only on Amazon. Request an invitation yourself',
          };
        }
        return null;
      },
    },
  ];

  // Text rules only run on sparse "interstitial" pages and inside visible dialogs. On a
  // full product page the title and headings are product copy and could say anything.
  const SPARSE_PAGE_MAX_LINKS = 30;
  const TEXT_RULES = [
    {
      id: 'queue-text', kind: 'queue', label: 'A queue or waiting room is showing',
      re: /you are (?:now )?in (?:the )?(?:line|queue)|you're in line|waiting room|virtual queue|queue-it|estimated wait(?:ing)? time|your (?:place|position|number) in (?:the )?(?:line|queue)/i,
    },
    {
      id: 'challenge-text', kind: 'challenge', label: 'A "verify you are human" check is showing',
      re: /just a moment\.\.\.|checking (?:if the site connection is secure|your browser)|verify(?:ing)? (?:that )?you are (?:a )?human|are you a (?:human|robot)|not a robot|press (?:&|and) hold|unusual traffic|confirm (?:that )?you(?:'re| are) (?:a )?human|human verification|bot detection/i,
    },
    {
      id: 'blocked-text', kind: 'blocked', label: 'The retailer is blocking access',
      re: /access (?:to this page )?(?:has been )?denied|you don't have permission to access|request (?:has been )?blocked|you(?:'ve| have) been blocked/i,
    },
  ];

  function hit(rule, loc) {
    return {
      kind: rule.kind,
      label: rule.label,
      rule: rule.id,
      signature: `${rule.kind}:${rule.id}:${loc.pathname}`.slice(0, 300),
    };
  }

  function interstitialText(doc) {
    if (!doc.body) return doc.title || '';
    if (doc.links.length <= SPARSE_PAGE_MAX_LINKS) {
      // innerText = rendered text only (no <script> bodies, nothing hidden).
      return `${doc.title}\n${doc.body.innerText.slice(0, 3000)}`;
    }
    const parts = [];
    const dialogs = doc.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]');
    for (let i = 0; i < Math.min(dialogs.length, 5); i++) {
      if (isVisible(dialogs[i], 50)) parts.push(dialogs[i].innerText.slice(0, 1000));
    }
    return parts.join('\n');
  }

  /**
   * @returns {{kind: string, label: string, rule: string, signature: string} | null}
   */
  function detectBlocker(doc = document, loc = location) {
    const host = loc.hostname.toLowerCase();
    for (const rule of HOST_RULES) {
      if (!rule.host.test(host)) continue;
      for (const p of rule.paths) if (p.re.test(loc.pathname)) return hit(p, loc);
      const extra = rule.check(doc);
      if (extra) return hit(extra, loc);
    }
    for (const rule of SELECTOR_RULES) {
      if (firstVisible(doc, rule.selector, rule.min)) return hit(rule, loc);
    }
    const text = interstitialText(doc);
    if (text) {
      for (const rule of TEXT_RULES) if (rule.re.test(text)) return hit(rule, loc);
    }
    return null;
  }

  /** @returns {string|null} reason if the page is an event/ticket listing */
  function detectTicketPage(doc = document) {
    const tg = RoBought.ticketGuard;
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    let budget = 500_000; // characters of JSON-LD we're willing to parse
    for (let i = 0; i < Math.min(scripts.length, 25); i++) {
      const text = scripts[i].textContent || '';
      if (text.length > budget) break;
      budget -= text.length;
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      const reason = tg.checkJsonLd(data);
      if (reason) return reason;
    }
    const ogType = doc.querySelector('meta[property="og:type"]')?.getAttribute('content') || '';
    if (/(?:^|\.)event$/i.test(ogType.trim())) return 'This page is marked up as an event.';
    const h1 = doc.querySelector('h1');
    return tg.checkText(doc.title) || tg.checkText(h1 ? textOf(h1) : '');
  }

  RoBought.guards = Object.freeze({ detectBlocker, detectTicketPage });
})();

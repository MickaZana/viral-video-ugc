const UPDATED = "21 July 2026";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface LegalIdentity {
  entityName: string;
  privacyEmail: string;
  address?: string;
}

function layout(title: string, description: string, body: string, identity: LegalIdentity): string {
  const email = escapeHtml(identity.privacyEmail);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="${escapeHtml(description)}" />
  <title>${escapeHtml(title)} · Viral Video UGC</title>
  <link rel="stylesheet" href="/tokens.css" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="site-header"><a class="logo" href="/">Viral Video UGC</a><nav class="legal-nav" aria-label="Legal"><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></header>
  <main class="legal-page">
    <p class="eyebrow">Legal</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="legal-updated">Last updated: ${UPDATED}</p>
    ${body}
    <section><h2>Contact</h2><p>Email <a href="mailto:${email}">${email}</a>${identity.address ? ` or write to ${escapeHtml(identity.address)}` : ""}.</p></section>
  </main>
  <footer class="site-footer"><p>© 2026 ${escapeHtml(identity.entityName)} · <a href="/">Home</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p></footer>
</body>
</html>`;
}

export function renderPrivacyPolicy(identity: LegalIdentity): string {
  const entity = escapeHtml(identity.entityName);
  return layout("Privacy Policy", "How Viral Video UGC handles personal data and YouTube API data, including GDPR rights and data-subject requests.", `
    <p class="legal-lead">This policy explains how ${entity} (“Viral Video UGC”, “we”, “us”) processes personal data when you visit our website, use our service, or connect a YouTube channel.</p>

    <section><h2>1. Who is responsible for your data?</h2><p>${entity} is the controller for account, billing, security, support and direct-service data. When an agency uses the service for a client, the agency or client may be the controller for campaign content and we may act as its processor. Contact us using the details below if you are unsure who controls a particular record.</p></section>

    <section><h2>2. Data we process</h2><ul>
      <li><strong>Account and organization data:</strong> name, email address, organization, role, client configuration and authentication records.</li>
      <li><strong>YouTube authorization data:</strong> the connected channel ID and display name, OAuth access and refresh tokens, token expiry, granted access status, and connection identifiers. Tokens are encrypted at rest and are never sent to browser JavaScript.</li>
      <li><strong>Content and publishing data:</strong> scripts, generated media, review decisions, upload status, YouTube video ID, destination channel ID and published URL.</li>
      <li><strong>Service and security data:</strong> IP address, request identifiers, timestamps, audit events, error reports, usage, cost and operational metrics.</li>
      <li><strong>Billing and communications:</strong> subscription status, transaction references, support messages and waitlist submissions. We do not store complete payment-card details.</li>
    </ul></section>

    <section><h2>3. How YouTube data is used</h2><p>Viral Video UGC uses the YouTube Data API Services. We request <code>youtube.readonly</code> to identify and display the channel you choose, and <code>youtube.upload</code> to upload a video only after an authorized human reviewer approves it. Uploads are created as private by default. We do not sell YouTube user data, use it for advertising, or use it to create undisclosed profiles.</p><p>Our use and transfer of information received from Google APIs follows the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including its Limited Use requirements, as well as the <a href="https://developers.google.com/youtube/terms/developer-policies">YouTube API Services Developer Policies</a>.</p></section>

    <section><h2>4. Why we process data</h2><ul>
      <li><strong>Contract:</strong> to provide accounts, channel connections, review workflows, generation and publishing requested by you.</li>
      <li><strong>Consent:</strong> when you authorize Google/YouTube access or choose optional communications. You may withdraw consent at any time.</li>
      <li><strong>Legitimate interests:</strong> to secure, debug and improve the service, prevent misuse and maintain reliable audit records, balanced against your rights.</li>
      <li><strong>Legal obligations:</strong> to meet tax, accounting, security and lawful-request requirements.</li>
    </ul></section>

    <section><h2>5. Sharing and international transfers</h2><p>We share data only as needed with service providers that operate the product, such as hosting and database providers, Google/YouTube, payment processing, and the generation vendors selected for a run. We do not sell personal data. Where personal data is transferred outside the EEA, we use an applicable lawful transfer mechanism, such as an adequacy decision or Standard Contractual Clauses, and supplementary safeguards where required.</p></section>

    <section><h2>6. Retention and deletion</h2><p>We retain account and service data only for as long as necessary for the stated purposes, an active contract, security, dispute resolution, or legal obligations. YouTube API data is refreshed or deleted within the periods required by YouTube policy. When you disconnect YouTube, revoke authorization, delete your account, or submit a valid deletion request, we revoke the relevant token and delete associated YouTube-authorized data as soon as possible and no later than seven calendar days, unless retention is legally required. This deletion affects data held by Viral Video UGC; it does not delete content held by YouTube.</p><p>You can also revoke access directly in <a href="https://security.google.com/settings/security/permissions">Google Security Settings</a>. To delete a video or other data held by YouTube, use YouTube itself.</p></section>

    <section><h2>7. Your GDPR rights and DSRs</h2><p>Where the GDPR applies, you may request access, correction, deletion, restriction, portability, or object to processing. You may withdraw consent without affecting earlier lawful processing. You may also lodge a complaint with the supervisory authority in your country of residence, work, or the place of the alleged infringement.</p><p>Submit a data-subject request (“DSR”) using the contact below with the subject <strong>Data Subject Request</strong>. Tell us which right you wish to exercise and the account or organization involved. We may request proportionate information to verify identity and authority. We normally respond within one month, subject to lawful extensions for complex or numerous requests. DSRs are free unless a request is manifestly unfounded or excessive.</p></section>

    <section><h2>8. Security and cookies</h2><p>We use access controls, encrypted OAuth tokens, secure session cookies, audit logging, rate limits and tenant isolation. No system is risk-free, and we continuously review these safeguards. The authenticated application uses strictly necessary session and security cookies. We do not use those cookies for cross-site advertising.</p></section>

    <section><h2>9. Changes</h2><p>We will update this policy when our processing changes. If a material change affects Google user data or the purpose for which it is used, we will provide appropriate notice and obtain renewed consent where required.</p></section>
  `, identity);
}

export function renderTerms(identity: LegalIdentity): string {
  const entity = escapeHtml(identity.entityName);
  return layout("Terms of Service", "Terms governing use of the Viral Video UGC private-beta service and its YouTube integration.", `
    <p class="legal-lead">These Terms govern your use of Viral Video UGC, operated by ${entity}. By creating an account or using the service, you agree to them.</p>
    <section><h2>1. Service and eligibility</h2><p>Viral Video UGC is a private-beta workflow for discovering content signals, creating original scripts and media, obtaining human approval, and publishing approved content. You must be legally able to enter a contract and authorized to act for every organization and channel you connect.</p></section>
    <section><h2>2. Your accounts and channels</h2><p>You are responsible for account security, authorized team access, accurate configuration, and activity performed through your account. Connect only YouTube channels that you own or are expressly authorized to manage. You may disconnect a channel at any time.</p></section>
    <section><h2>3. YouTube</h2><p>The service uses YouTube API Services. By using the YouTube integration, you also agree to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a> and acknowledge Google’s <a href="https://policies.google.com/privacy">Privacy Policy</a>. YouTube controls its platform, API availability, quotas, moderation and account decisions. We cannot guarantee continued API access or publication.</p></section>
    <section><h2>4. Content and approval</h2><p>You retain your rights in content you provide. You grant us a limited right to process it solely to provide, secure and support the service. You are responsible for ensuring that source material, prompts, music, trademarks, likenesses, claims and final videos comply with law, platform rules and third-party rights. Generated output may be inaccurate or similar to other content. A human reviewer must evaluate every video before publishing.</p></section>
    <section><h2>5. Acceptable use</h2><p>You must not use the service to infringe rights, impersonate others, mislead audiences, distribute unlawful or harmful material, manipulate platform systems, bypass access controls, introduce malware, scrape prohibited data, or exceed provider/API limits. We may suspend access reasonably necessary to protect users, providers or the service.</p></section>
    <section><h2>6. Fees and cancellation</h2><p>Paid features, limits, billing periods and taxes are shown at checkout or in an order form. Fees already incurred are non-refundable except where law or the applicable offer requires otherwise. You may cancel future renewal through the available billing controls.</p></section>
    <section><h2>7. Privacy and deletion</h2><p>Our <a href="/privacy">Privacy Policy</a> explains personal-data and YouTube-data processing, GDPR rights, data-subject requests, retention, revocation and deletion.</p></section>
    <section><h2>8. Beta service and warranties</h2><p>The service is provided on an “as is” and “as available” basis during private beta. Features may change and third-party vendors may fail or discontinue service. To the extent permitted by law, we disclaim implied warranties, but nothing in these Terms excludes rights or liabilities that cannot lawfully be excluded.</p></section>
    <section><h2>9. Liability</h2><p>To the extent permitted by law, neither party is liable for indirect or consequential loss. Our aggregate liability arising from the service will not exceed the fees paid for the service during the twelve months before the event giving rise to the claim. These limits do not apply where prohibited by law, including liability that cannot be limited for fraud, wilful misconduct, death or personal injury.</p></section>
    <section><h2>10. Termination</h2><p>You may stop using the service and disconnect integrations at any time. We may suspend or terminate access for material breach, unlawful use, security risk, non-payment or provider requirements. On termination, we will handle retained personal and YouTube-authorized data as described in the Privacy Policy.</p></section>
    <section><h2>11. Governing terms</h2><p>Any governing-law and venue terms agreed in an order form take precedence. Otherwise, mandatory consumer and data-protection rights in your country remain unaffected. If part of these Terms is unenforceable, the remainder continues to apply. We may update these Terms prospectively and will provide reasonable notice of material changes.</p></section>
  `, identity);
}

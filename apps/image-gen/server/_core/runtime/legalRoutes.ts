import type express from "express";
import { formatFaceMemoryRetentionDays } from "../faceMemoryRetention";

export function registerLegalRoutes(app: express.Express) {
  app.get("/privacy", (_req, res) => {
    const faceMemoryRetention = formatFaceMemoryRetentionDays("en");
    res.type("html").send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Privacy Policy – Leaderbot</title>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        :root { color-scheme: dark; }
        body {
          font-family: Arial, sans-serif;
          max-width: 700px;
          margin: 40px auto;
          line-height: 1.6;
          padding: 24px;
          color: #e5e7eb;
          background: #0b1220;
        }
        h1, h2 { color: #f9fafb; }
        ul { padding-left: 20px; }
        a { color: #93c5fd; }
      </style>
    </head>
    <body>
      <h1>Privacy Policy – Leaderbot</h1>
      <p><strong>Last updated:</strong> 21 April 2026</p>
      <p>Leaderbot ("we", "our") is a Messenger-based service that generates and edits images with AI based on your prompts.</p>

      <h2>What data we collect</h2>
      <p>When you interact with Leaderbot through Facebook Messenger, we may receive:</p>
      <ul>
        <li>Messages you send to the Page</li>
        <li>Images you submit for editing</li>
        <li>Basic messaging metadata necessary to deliver the service (e.g., sender ID, timestamps)</li>
      </ul>
      <p>We do not request your password or access your private Facebook profile data beyond what Messenger delivers for this integration.</p>

      <h2>How we use data</h2>
      <p>We use your data only to:</p>
      <ul>
        <li>Receive your request</li>
        <li>Generate a new image or edit your submitted image</li>
        <li>Send the generated or edited image back to you in Messenger</li>
        <li>Maintain service reliability, prevent abuse, and troubleshoot issues</li>
      </ul>

      <h2>Image handling and retention</h2>
      <p>Images are processed for the purpose of generating or editing the image you requested.</p>
      <p><strong>Optional photo memory:</strong> If you give explicit permission, we keep your uploaded photo for a maximum of ${faceMemoryRetention} so you do not have to upload it again each time. This is optional. You can withdraw consent at any time by sending "delete my data" in Messenger. Dutch-speaking users may send "verwijder mijn data". After ${faceMemoryRetention} or withdrawal, the retained photo is permanently deleted. We use it only to generate new images for you.</p>
      <p>We do not sell your images.</p>
      <p>We do not use your images to market to you.</p>
      <p>We do not share your images with third parties except as required to provide the service (e.g., image processing providers).</p>
      <p>Images and generated outputs are retained only as long as needed to deliver the result and ensure basic operational stability, then deleted or anonymized.</p>

      <h2>Sharing and third parties</h2>
      <p>We may use third-party infrastructure providers (hosting, logging, and image processing) solely to operate the service. We do not share personal data for advertising purposes.</p>

      <h2>Security</h2>
      <p>We take reasonable measures to protect data in transit and at rest. No system is 100% secure, but we aim to minimize data exposure and access.</p>

      <h2>Your choices</h2>
      <p>You can stop using the service at any time by not messaging the Page.</p>

      <h2>Data deletion requests</h2>
      <p>You can request deletion by sending "delete my data" in Messenger or by contacting us at: privacy@leaderbot.live</p>
      <p>Include your Facebook profile name and the approximate time you messaged the Page so we can locate your conversation context.</p>
      <p>Messages and account data retained by Meta/Facebook are controlled by Meta and must be managed through Facebook's own settings and deletion tools.</p>

      <h2>Contact</h2>
      <p>Email: privacy@leaderbot.live</p>
    </body>
    </html>
  `);
  });

  app.get("/terms", (_req, res) => {
    res.type("html").send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Terms of Service – Leaderbot</title>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        :root { color-scheme: dark; }
        body {
          font-family: Arial, sans-serif;
          max-width: 700px;
          margin: 40px auto;
          line-height: 1.6;
          padding: 24px;
          color: #e5e7eb;
          background: #0b1220;
        }
        h1, h2 { color: #f9fafb; }
        ul { padding-left: 20px; }
        a { color: #93c5fd; }
      </style>
    </head>
    <body>
      <h1>Terms of Service – Leaderbot</h1>
      <p><strong>Last updated:</strong> 21 June 2026</p>
      <p>Leaderbot is an AI assistant that can reply in Messenger and generate or edit images from user-provided prompts and images.</p>

      <h2>Acceptable use</h2>
      <p>By using Leaderbot, you agree not to submit requests or images that are unlawful, abusive, infringing, deceptive, or intended to harm other people or systems.</p>

      <h2>AI-generated content</h2>
      <p>Outputs are generated by AI and may be inaccurate, incomplete, or unexpected. You are responsible for reviewing outputs before relying on or sharing them.</p>

      <h2>Messenger and Meta</h2>
      <p>Leaderbot operates through Facebook Messenger but is not endorsed by or affiliated with Meta. Messenger delivery, account controls, and Facebook-retained message history are governed by Meta's own terms and settings.</p>

      <h2>Availability and limits</h2>
      <p>The service may enforce quotas, rate limits, budget limits, abuse protection, and temporary feature restrictions to protect reliability and cost.</p>

      <h2>Privacy and deletion</h2>
      <p>Our privacy policy explains what data we process and how deletion requests work. See <a href="/privacy">/privacy</a> and <a href="/data-deletion">/data-deletion</a>.</p>

      <h2>Contact</h2>
      <p>Email: privacy@leaderbot.live</p>
    </body>
    </html>
  `);
  });

  app.get("/data-deletion", (_req, res) => {
    res.type("html").send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>User Data Deletion Instructions – Leaderbot</title>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        :root { color-scheme: dark; }
        body {
          font-family: Arial, sans-serif;
          max-width: 700px;
          margin: 40px auto;
          line-height: 1.6;
          padding: 24px;
          color: #e5e7eb;
          background: #0b1220;
        }
        h1, h2 { color: #f9fafb; }
        ul { padding-left: 20px; }
        a { color: #93c5fd; }
      </style>
    </head>
    <body>
      <h1>User Data Deletion Instructions – Leaderbot</h1>
      <p>If you want your data removed from Leaderbot, you can request deletion at any time.</p>

      <h2>Data that can be deleted</h2>
      <ul>
        <li>Conversation identifiers and message logs associated with your interaction history</li>
        <li>Retained images and generated outputs, if any are still stored</li>
        <li>Optional photo-memory state if you previously gave consent</li>
      </ul>

      <h2>How to request deletion</h2>
      <p>You can send <strong>delete my data</strong> in Messenger. Dutch-speaking users may send <strong>verwijder mijn data</strong>.</p>
      <p>Email your request to: <strong>privacy@leaderbot.live</strong></p>
      <p>To help us identify your records accurately, include:</p>
      <ul>
        <li>Your Facebook profile name</li>
        <li>The approximate time you messaged the Page</li>
      </ul>

      <h2>Processing timeframe</h2>
      <p>After we verify your request details, deletion is completed within a reasonable timeframe.</p>

      <h2>Facebook-controlled data</h2>
      <p>Messages and account data retained by Meta/Facebook are controlled by Meta and must be managed through Facebook's own settings and deletion tools.</p>
    </body>
    </html>
  `);
  });
}

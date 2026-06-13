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
      <p>If you want us to delete data associated with your interactions, contact us at: privacy@leaderbot.live</p>
      <p>Include your Facebook profile name and the approximate time you messaged the Page so we can locate your conversation context.</p>

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
      </ul>

      <h2>How to request deletion</h2>
      <p>Email your request to: <strong>privacy@leaderbot.live</strong></p>
      <p>To help us identify your records accurately, include:</p>
      <ul>
        <li>Your Facebook profile name</li>
        <li>The approximate time you messaged the Page</li>
      </ul>

      <h2>Processing timeframe</h2>
      <p>After we verify your request details, deletion is completed within a reasonable timeframe.</p>
    </body>
    </html>
  `);
  });
}

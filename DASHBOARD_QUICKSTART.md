# 📊 Dashboard Quick Start

## What Was Created

We've built a complete web dashboard system for monitoring your Limitless Bot:

### 1. **Bot Updates** (this repo)
- Added S3 upload capability (optional, controlled by `S3_UPLOAD_ENABLED`)
- Automatically uploads trades, stats, redemptions, and state to S3
- No impact on bot performance
- Configurable upload interval (default: 60 seconds)

### 2. **Dashboard Repo** (`../limitless-dashboard`)
- Full React + TypeScript dashboard
- Real-time monitoring of trades and positions
- Beautiful UI with Tailwind CSS
- Auto-refresh every 30 seconds
- Ready for AWS S3 + CloudFront deployment

## Quick Setup (5 minutes)

### 1. Enable S3 Upload in Bot

Add to your `.env`:

```env
S3_UPLOAD_ENABLED=true
S3_BUCKET_NAME=limitless-bot-logs
S3_REGION=us-east-1
S3_UPLOAD_INTERVAL_MS=60000
```

### 2. Create S3 Bucket

```bash
aws s3 mb s3://limitless-bot-logs --region us-east-1
```

### 3. Make Bucket Public (for reading)

```bash
# Download the policy file
cat > /tmp/bucket-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadGetObject",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::limitless-bot-logs/*"
  }]
}
EOF

# Apply policy
aws s3api put-bucket-policy --bucket limitless-bot-logs --policy file:///tmp/bucket-policy.json

# Configure CORS
cat > /tmp/cors.json <<EOF
[{
  "AllowedHeaders": ["*"],
  "AllowedMethods": ["GET", "HEAD"],
  "AllowedOrigins": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000
}]
EOF

aws s3api put-bucket-cors --bucket limitless-bot-logs --cors-configuration file:///tmp/cors.json
```

### 4. Install Bot Dependencies

```bash
npm install
```

### 5. Restart Bot

```bash
npm start
```

You should see:
```
📤 S3 upload enabled: Bucket=limitless-bot-logs, Region=us-east-1, Interval=60000ms
📤 [S3] Starting periodic uploads every 60000ms
✅ [S3] Uploaded trades.jsonl
✅ [S3] Uploaded stats.json
...
```

### 6. Setup Dashboard

```bash
cd ../limitless-dashboard
npm install
npm run dev
```

Open http://localhost:5173 - you should see your live dashboard!

## What You'll See

### Stats Overview
- Total trades
- Win rate
- Net P&L (profit/loss)
- Uptime

### Active Positions
- All open positions
- Entry prices
- Cost basis
- Strategies
- Deadlines

### Trade History
- All buys, sells, redemptions
- P&L per trade
- Transaction links
- Market names

## Deploy to Production

See `../limitless-dashboard/SETUP.md` for full AWS deployment guide.

Quick version:

```bash
# Build dashboard
cd ../limitless-dashboard
npm run build

# Create website bucket
aws s3 mb s3://limitless-dashboard-site
aws s3 website s3://limitless-dashboard-site --index-document index.html

# Deploy
aws s3 sync dist/ s3://limitless-dashboard-site --delete

# Get URL
echo "http://limitless-dashboard-site.s3-website-us-east-1.amazonaws.com"
```

## Features

- ✅ Real-time updates (auto-refresh every 30 seconds)
- ✅ Responsive design (works on mobile)
- ✅ No backend required (pure S3)
- ✅ Low cost (~$2-5/month)
- ✅ Secure (read-only access)
- ✅ Fast (served from S3/CloudFront)

## Cost Breakdown

- S3 Storage: ~$0.50/month
- S3 Requests: ~$0.10/month
- Data Transfer: ~$1-3/month
- **Total: ~$2-5/month**

## Disable S3 Upload

Set in `.env`:

```env
S3_UPLOAD_ENABLED=false
```

Bot will continue working normally, just won't upload to S3.

## Troubleshooting

**Dashboard shows "No trades yet"**
- Wait 60 seconds for first upload
- Check: `aws s3 ls s3://limitless-bot-logs/`
- Verify `S3_UPLOAD_ENABLED=true` in bot .env

**"Access Denied" errors**
- Check bucket policy is applied
- Verify CORS configuration
- Ensure bucket name matches in bot and dashboard

**Bot not uploading**
- Check bot logs for S3 errors
- Verify AWS credentials (or use IAM role)
- Test: `aws s3 ls s3://limitless-bot-logs/`

## Next Steps

- Add CloudFront for HTTPS
- Setup custom domain
- Add authentication
- Create mobile app
- Add more analytics

---

Happy monitoring! 🚀

For detailed setup: see `../limitless-dashboard/SETUP.md`

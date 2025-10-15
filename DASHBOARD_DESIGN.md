# Limitless Bot Dashboard Design

## Overview
A web dashboard to monitor bot trading activity, including buys, sells, and profits in real-time.

## Architecture: Serverless Static Dashboard

### Components

```
┌─────────────────┐
│  Limitless Bot  │
│   (This Repo)   │
└────────┬────────┘
         │ Upload logs via AWS SDK
         ↓
┌─────────────────┐
│   S3 Bucket     │
│  - trades.jsonl │
│  - stats.json   │
│  - redemptions  │
└────────┬────────┘
         │
         ↓
┌─────────────────┐      ┌──────────────┐
│   CloudFront    │ ←──→ │ React SPA    │
│   (CDN/Cache)   │      │ Dashboard    │
└─────────────────┘      └──────────────┘
```

### Tech Stack

#### Frontend (New Repo: `limitless-dashboard`)
- **Framework**: Next.js 14+ (with static export) or Vite + React
- **UI Library**: Tailwind CSS + shadcn/ui or Chakra UI
- **Charts**: Recharts or Chart.js
- **State**: React Query for data fetching
- **Hosting**: S3 + CloudFront

#### Backend (Minimal)
- **Storage**: S3 for log files
- **Optional API**: Lambda functions if needed for aggregations
- **Auth**: Cognito (optional, for access control)

#### Bot Updates (This Repo)
- Add AWS SDK to upload logs to S3
- Keep existing file logging for local backup

## Features

### Phase 1: Basic Dashboard
1. **Overview Stats**
   - Total trades
   - Win rate
   - Total P&L
   - Active positions

2. **Trades Table**
   - Recent buys/sells
   - Market names
   - Entry/exit prices
   - P&L per trade
   - Timestamps

3. **Charts**
   - P&L over time
   - Win/loss ratio
   - Hourly activity

### Phase 2: Advanced Features
1. **Live Updates**
   - WebSocket or polling for real-time data
   - Toast notifications for new trades

2. **Market Analysis**
   - Performance by market
   - Strategy comparison (early contrarian vs late window)
   - Time-based analysis

3. **Redemption Tracking**
   - Pending redemptions
   - Redemption success/failure logs
   - Claimed amounts

### Phase 3: Advanced Analytics
1. **Portfolio View**
   - Current holdings
   - Unrealized P&L
   - Market deadlines

2. **Performance Metrics**
   - Sharpe ratio
   - Max drawdown
   - ROI calculations

3. **Alerts**
   - Email/SMS for large losses
   - SNS notifications for errors

## Implementation Plan

### Step 1: Update Bot to Upload Logs to S3

Add to `package.json`:
```json
{
  "dependencies": {
    "@aws-sdk/client-s3": "^3.x.x"
  }
}
```

Add S3 upload logic:
```javascript
// Upload logs to S3 after each trade
async function uploadLogsToS3() {
  // Upload trades.jsonl, stats.json, redemptions.jsonl
}
```

### Step 2: Create Dashboard Repo

**Repository**: https://github.com/0xfarme/limitless-dashboard

```bash
# Clone the dashboard repository
git clone https://github.com/0xfarme/limitless-dashboard.git
cd limitless-dashboard

# Repository structure
limitless-dashboard/
├── src/
│   ├── components/
│   │   ├── StatsOverview.tsx
│   │   ├── TradesTable.tsx
│   │   ├── ProfitChart.tsx
│   │   └── PositionsTable.tsx
│   ├── lib/
│   │   ├── s3Client.ts       # Fetch logs from S3
│   │   └── parseData.ts      # Parse JSONL files
│   ├── pages/
│   │   ├── index.tsx         # Dashboard home
│   │   ├── trades.tsx        # Detailed trades
│   │   └── positions.tsx     # Active positions
│   └── styles/
├── public/
├── package.json
└── next.config.js
```

### Step 3: Deploy Infrastructure

Use AWS CDK or CloudFormation:

```typescript
// infrastructure/dashboard-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

export class DashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // S3 bucket for logs
    const logsBucket = new s3.Bucket(this, 'BotLogsBucket', {
      versioned: true,
      cors: [/* CORS rules */]
    });

    // S3 bucket for static site
    const siteBucket = new s3.Bucket(this, 'DashboardSiteBucket', {
      websiteIndexDocument: 'index.html',
      publicReadAccess: true
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(siteBucket)
      }
    });
  }
}
```

## Cost Estimate (AWS)

### Monthly Costs (Low Traffic)
- **S3 Storage**: ~$0.50 (20GB logs)
- **CloudFront**: ~$1.00 (10GB transfer)
- **Lambda** (optional): Free tier covers most usage
- **Total**: ~$2-5/month

### Monthly Costs (Medium Traffic - 1000 visitors)
- **S3 Storage**: ~$0.50
- **CloudFront**: ~$5.00
- **Lambda**: ~$0.50
- **Total**: ~$6-10/month

## Security Considerations

1. **Access Control**
   - Use CloudFront signed URLs or Cognito
   - API keys for bot → S3 uploads
   - Read-only S3 bucket policy for dashboard

2. **Data Privacy**
   - Redact wallet addresses in public logs
   - Use environment variables for sensitive data
   - Enable S3 encryption at rest

3. **CORS Configuration**
   - Allow only your CloudFront domain
   - Restrict S3 bucket access

## Development Workflow

1. **Local Development**
   ```bash
   # Dashboard repo
   npm run dev           # Start Next.js dev server
   npm run build         # Build static site
   npm run export        # Export to /out directory
   ```

2. **Deployment**
   ```bash
   # Deploy to S3
   aws s3 sync out/ s3://your-dashboard-bucket/

   # Invalidate CloudFront cache
   aws cloudfront create-invalidation \
     --distribution-id YOUR_DIST_ID \
     --paths "/*"
   ```

3. **CI/CD** (Optional)
   - GitHub Actions to auto-deploy on push
   - Automatically build and sync to S3

## Alternative: Use Existing Tools

If you want something quicker, consider:

1. **Grafana Cloud** (Free tier)
   - Import JSONL logs
   - Pre-built dashboards
   - No coding needed

2. **Retool** (Low-code)
   - Connect to S3
   - Drag-and-drop UI builder
   - Fast to set up

3. **Metabase/Superset** (Open source)
   - Self-hosted BI tool
   - SQL queries on logs
   - Rich visualizations

## Recommended Next Steps

1. ✅ Create new repo: `limitless-dashboard`
2. ⚙️ Add S3 upload logic to bot
3. 🎨 Build basic React dashboard with mock data
4. ☁️ Set up S3 + CloudFront infrastructure
5. 🔗 Connect dashboard to real S3 logs
6. 🚀 Deploy and test
7. 📊 Add advanced charts and analytics

## Questions to Consider

1. **Public or Private?**
   - Public: Anyone can view (use fake/demo data)
   - Private: Authentication required (Cognito)

2. **Real-time or Batch?**
   - Real-time: Upload logs immediately after each trade
   - Batch: Upload every 5-15 minutes

3. **Historical Data?**
   - How far back to keep logs?
   - Aggregation strategy for old data

4. **Multi-wallet Support?**
   - Dashboard for single wallet or multiple?
   - Filter/group by wallet address

Let me know your preferences and I can help implement!

#!/bin/bash
# 介護食事記録システム - GCPデプロイスクリプト
set -e

# ── 設定 ──────────────────────────────────
PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
REGION="asia-northeast1"
SERVICE="care-meal-record"

echo ""
echo "======================================"
echo "  介護食事記録システム GCPデプロイ"
echo "======================================"
echo "  プロジェクト: ${PROJECT_ID}"
echo "  リージョン:   ${REGION}"
echo "======================================"
echo ""

if [ -z "$PROJECT_ID" ]; then
  echo "❌ GCPプロジェクトが未設定です"
  echo "   実行: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

if [ -z "$FIREBASE_API_KEY" ]; then
  echo "❌ FIREBASE_API_KEY が未設定です"
  echo ""
  echo "取得方法:"
  echo "  1. https://console.firebase.google.com を開く"
  echo "  2. プロジェクト ${PROJECT_ID} を選択（なければ「プロジェクトを追加」→ 既存GCPプロジェクトを選択）"
  echo "  3. プロジェクト設定 → 全般 → ウェブアプリ → 設定"
  echo "  4. apiKey の値をコピーして以下を実行:"
  echo "     export FIREBASE_API_KEY=AIzaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  echo ""
  exit 1
fi

echo "📦 APIを有効化中..."
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  aiplatform.googleapis.com \
  firebase.googleapis.com \
  cloudbuild.googleapis.com \
  --project="${PROJECT_ID}" --quiet

echo ""
echo "🗄️  Firestore を確認中..."
gcloud firestore databases describe --project="${PROJECT_ID}" --quiet 2>/dev/null || \
  gcloud firestore databases create --location="${REGION}" --project="${PROJECT_ID}" --quiet

echo ""
echo "🚀 Cloud Run にデプロイ中..."
gcloud run deploy "${SERVICE}" \
  --source . \
  --region "${REGION}" \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --timeout 60 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},FIREBASE_API_KEY=${FIREBASE_API_KEY},FIREBASE_AUTH_DOMAIN=${PROJECT_ID}.firebaseapp.com,VERTEX_LOCATION=${REGION}" \
  --project "${PROJECT_ID}"

SERVICE_URL=$(gcloud run services describe "${SERVICE}" --region "${REGION}" --project "${PROJECT_ID}" --format "value(status.url)")

echo ""
echo "======================================"
echo "  ✅ デプロイ完了！"
echo "======================================"
echo ""
echo "  アプリURL: ${SERVICE_URL}"
echo ""
echo "======================================"
echo "  次のステップ（Firebase Auth設定）"
echo "======================================"
echo ""
echo "  1. https://console.firebase.google.com を開く"
echo "  2. プロジェクト ${PROJECT_ID} → Authentication"
echo "  3. 「Sign-in method」→「Google」を有効化"
echo "  4. 「承認済みドメイン」に以下を追加:"
echo "     ${SERVICE_URL#https://}"
echo ""
echo "  設定後、${SERVICE_URL} からアクセスできます"
echo ""

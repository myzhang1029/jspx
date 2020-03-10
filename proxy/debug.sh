cd $(dirname $0)
webpack \
  --o "../docs/assets/bundle.debug.js" \
  --mode development

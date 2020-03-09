DST=../www/assets

rm $DST/bundle.*.js

webpack \
  --o "$DST/bundle.[hash:8].js" \
  --mode production

cd $DST

for i in bundle.*.js; do
  printf "\
jsproxy_config=\
x=>{\
importScripts('assets/$i')\
};\
importScripts('conf.js')\
" > ../sw.js
done

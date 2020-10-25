DST=../docs/assets

cd $(dirname $0)

webpack \
  -o "$DST" \
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

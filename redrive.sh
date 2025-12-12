#!/usr/bin/env bash

for arg in "$@"; do
  case $arg in
    -f=*|--filename=*)
    fileName+=("${arg#*=}")
    shift;;
    -s=*|--service=*)
    service+=("${arg#*=}")
    shift;;
    -st=*|--stage=*)
    stage+=("${arg#*=}")
    shift;;
    -r=*|--region=*)
    region+=("${arg#*=}")
    shift;;
    -fn=*|--function=*)
    function+=("${arg#*=}")
    shift;;
    -qn=*|--queueName=*)
    queueName+=("${arg#*=}")
    shift;;
    --rate=*)
    rate+=("${arg#*=}")
    shift;;
    -d|--downloaded)
    downloaded=true
    shift;;
    -rt|--retry)
    retry=true
    shift;;
  esac
done

readonly filedate=$(date +"%Y.%m.%d_%A_%H.%M.%S_%Z")
echo ""

help() {
  echo ""
  echo "Required parameters:"
  echo -e '\t'"-s --service"'\t\t'"The service in question"
  echo -e '\t'"-st --stage"'\t\t'"The stage in question"
  echo -e '\t'"-r --region"'\t\t'"The region in question"
  echo -e '\t'"-fn --function"'\t\t'"The function to redrive"
  echo "Optional parameters:"
  echo -e '\t'"-d --downloaded"'\t\t'"the logfile was downloaded, search for it in a different directory"
  echo -e '\t'"-f --filename"'\t\t'"filename to redrive messages from"
}

redriveFromQueue() {
  echo "Redriving from queue" && echo ""
  echo "filedate: ${filedate}"
  echo "redrivePath: ${redrivePath}" && echo ""
  sleep 1
  # NODE_OPTIONS="--max-old-space-size=4096" bin/dlq.js --rate ${rate} \
  NODE_OPTIONS="--max-old-space-size=12288" bin/dlq.js --rate ${rate} \
    --time 60 \
    --region ${region} \
    --env ${stage} \
    --function-name ${service}-${stage}-${function} \
    --redrive --log ${redrivePath}/${function}_${region}- > ${redrivePath}/${function}_${region}_${filedate}.json
  echo ""
}

main() {
  yarn build

  echo "service: ${service}"
  echo "stage: ${stage}"
  echo "region: ${region}"
  echo "function: ${function}"
  echo "retry: ${retry}"
  echo;

  redrivePath="var/${service}/${stage}/${function}/redrive/${region}/${function}_${region}_${filedate}"
  mkdir -p "${redrivePath}"

  echo "$(date)"
  echo;
  redriveFromQueue
}

if [[ -z "${service}" ]] || [[ -z "${stage}" ]] || [[ -z "${region}" ]] || [[ -z "${function}" ]]; then
  help
else
  main
fi

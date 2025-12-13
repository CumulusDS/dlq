#!/usr/bin/env zsh

#set -euf -o pipefail

main() {
  redrivePath="${1}"
  echo "redrivePath: ${redrivePath}"
  echo;

  declare -r USER_POOL_ID="us-east-1_4E15UzcWl"
  declare -r storage_name_prefix="${redrivePath:t}"

  error_count="$(grep -ri " is not in site spm" "./${redrivePath}" | sort | uniq | wc -l)"
  echo "error_count: ${error_count}"

  error_lines_file="${storage_name_prefix}_user-not-in-site-spm_error-lines.txt"
  echo "filtering error lines for user not in spm into ${error_lines_file}"
  grep -ri " is not in site spm" "${redrivePath}" | sort | uniq > "./${error_lines_file}"

  error_lines_json_blob_list="${storage_name_prefix}_user-not-in-site-spm_json-blob-list.txt"
  echo "trimming error lines into "${error_lines_json_blob_list}
  sed -e "s#^${redrivePath}.*ERROR##" -e "s/^[[:space:]]*//" "${error_lines_file}" > "${error_lines_json_blob_list}"

  error_lines_json_blob_list_count="$(cat "${error_lines_json_blob_list}" | wc -l)"
  echo "there are ${error_lines_json_blob_list_count} lines in this list"

  error_lines_json_blob_list_unique="${storage_name_prefix}_user-not-in-site-spm_json-blob-list_unique.txt"
  cat "${error_lines_json_blob_list}" | sort | uniq > "${error_lines_json_blob_list_unique}"

  error_lines_json_blob_list_unique_count="$(cat "${error_lines_json_blob_list_unique}" | wc -l)"
  echo "${error_lines_json_blob_list_unique_count} of them are unique"

  error_messages="$(cat "${error_lines_json_blob_list_unique}" | jq -s ".[].error.message" | sort | uniq)"
  error_messages_count="$(echo "${error_messages}" | wc -l)"

  #echo "${error_messages}" | jq "."
  echo;
  echo "error_messages_count: ${error_messages_count}"

  user_names_not_in_spm="${storage_name_prefix}_spm_user-names.txt"
  cat "${error_lines_json_blob_list_unique}" | jq -s ".[].error.message" \
    | sort \
    | uniq \
    | grep 'is not in site spm"' \
    | sed -e 's/^\"user //' -e 's/is not in site spm\"$//' > "${user_names_not_in_spm}"
  echo "user_names_not_in_spm: $(cat ${user_names_not_in_spm} | wc -l)"

  user_names_not_in_spm_train="${storage_name_prefix}_spm-train_user-names.txt"
  cat "${error_lines_json_blob_list_unique}" | jq -s ".[].error.message" \
    | sort \
    | uniq \
    | grep 'is not in site spm-train"' \
    | sed -e 's/^\"user //' -e 's/is not in site spm-train\"$//' > "${user_names_not_in_spm_train}"
  echo "user_names_not_in_spm_train: $(cat ${user_names_not_in_spm_train} | wc -l)"

  user_names_dedpuplicated="${storage_name_prefix}_user-names-deduplicated.txt"
  cat "${user_names_not_in_spm}" "${user_names_not_in_spm_train}" | sort | uniq > "${user_names_dedpuplicated}"
  echo "user_names_dedpuplicated: $(cat ${user_names_dedpuplicated} | wc -l)"

  sleep 1;
  echo;

  start_date="$(date)"
  echo "Start: ${start_date}"
  echo;

  while IFS= read -r line; do
    echo "${line//[^[:alnum:]-]/}"
    # get a list of all groups for the user
    groups="$(awsudo -u sts-prod aws cognito-idp admin-list-groups-for-user \
      --user-pool-id "${USER_POOL_ID}" \
      --username "${line//[^[:alnum:]-]/}")"

    # filter and create an array of only the pennchem groups
    declare -a pennchem_groups=($(echo "${groups}" | jq -r ".Groups[] | .GroupName" | grep "pennchem"))

    # add user to spm version of any pennchem group that they exist in
    for g in "${pennchem_groups[@]}"; do
      # create a string var that substitutes "pennchem" => "spm"
      spm_equivalent="$(echo "${g}" | sed "s/pennchem/spm/")"
      echo "${g} => ${spm_equivalent}"

      # add the user to the spm group
      awsudo -u sts-prod aws cognito-idp admin-add-user-to-group \
        --user-pool-id "${USER_POOL_ID}" \
        --username "${line//[^[:alnum:]-]/}" \
        --group-name "${spm_equivalent}"

      # take a nap
      sleep 0.1
      unset spm_equivalent
    done

    # take another nap
    sleep 0.1
    unset groups pennchem_groups
    echo;
  done < "${user_names_dedpuplicated}"

  # handle spm-train separately
  while IFS= read -r line; do
    echo "${line//[^[:alnum:]-]/}"
    # get a list of all groups for the user
    groups="$(awsudo -u sts-prod aws cognito-idp admin-list-groups-for-user \
      --user-pool-id "${USER_POOL_ID}" \
      --username "${line//[^[:alnum:]-]/}")"

    # filter and create an array of only the pennchem groups
    declare -a pennchem_groups=($(echo "${groups}" | jq -r ".Groups[] | .GroupName" | grep "pennchem"))

    # add user to spm version of any pennchem group that they exist in
    for g in "${pennchem_groups[@]}"; do
      # create a string var that substitutes "pennchem" => "spm"
      spm_equivalent="$(echo "${g}" | sed "s/pennchem-training/spm-strain/")"
      echo "${g} => ${spm_equivalent}"

      # add the user to the spm group
      awsudo -u sts-prod aws cognito-idp admin-add-user-to-group \
        --user-pool-id "${USER_POOL_ID}" \
        --username "${line//[^[:alnum:]-]/}" \
        --group-name "${spm_equivalent}"

      # take a nap
      sleep 0.1
      unset spm_equivalent
    done

    # take another nap
    sleep 0.1
    unset groups pennchem_groups
    echo;
  done < "${user_names_not_in_spm_train}"

  echo "Started adding to groups at ${start_date}"
  echo "Completed at $(date)"
}

main "${@}"

UPDATE vibetb.notification_template
   SET body = replace(body, '{{ document.copy_note }}', 'A copy is available for your records.')
 WHERE kind = 'signature_complete'
   AND channel = 'EMAIL'
   AND body LIKE '%{{ document.copy_note }}%';

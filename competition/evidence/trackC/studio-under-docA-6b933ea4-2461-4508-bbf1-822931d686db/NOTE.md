Local replay (sprint container, 2026-11-27 18:08 Taipei): the organizer record was built from the REAL ComPDF documentParsing
output (competition/evidence/compdf/compdf-parsing-raw-2026-11-27T09-56-03-523Z.txt, task 265f019f-…) and the REAL Claude
interpretation (competition/evidence/trackC/interpretation-A-…json, msg_011ChTEf9r3Yss1nuDD7WBfK), because this container
cannot reach ComPDF. Confirmation went through the real API (`POST /api/organizer/documents/<id>/confirm`) with every right
ticked: only document-"allowed" rights were enabled (photos, personal download); videos (restricted), sharing (restricted)
and official assets (unknown) stayed disabled. The studio job then ran live (Claude + FFmpeg) under that policy: the sample
video was excluded and the event name/venue came from the document.

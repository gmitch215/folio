## Architecture x86_64

Correctness pass: 282 rows, wrong outputs 0, errors 0, serial mismatches 0.

| Session | Span (UTC) | Rows | Errors | Wrong | Flagged | Over 50x median | Load label | Router geomean | Min | p10 (harness) | Gate 1 | Gate 2 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
| s1 | 20:20 to 20:33 | 2820 | 0 | 0 | 0 | 0 | quiet | 0.897 | 0.597 | 0.716 | NOT MET | NOT MET |
| s2 | 20:52 to 21:05 | 2820 | 0 | 0 | 0 | 0 | quiet | 0.900 | 0.577 | 0.718 | NOT MET | NOT MET |
| s3 | 21:24 to 21:37 | 2820 | 0 | 0 | 0 | 0 | quiet | 0.900 | 0.593 | 0.719 | NOT MET | NOT MET |
| pooled 30 rounds | | | | | | | | 0.899 | 0.594 | 0.722 | NOT MET | NOT MET |

### Session s1: contamination and load

Rows 2820, errors 0, wrong outputs 0, flagged 0 (none), over 50x the arm median 0.
Sampler: {"ticks":263,"loadMax":2.13,"busyMax":18.3,"otherAbove10":[],"lockTicks":0,"label":"quiet"}.


### Session s2: contamination and load

Rows 2820, errors 0, wrong outputs 0, flagged 0 (none), over 50x the arm median 0.
Sampler: {"ticks":264,"loadMax":2.22,"busyMax":18.9,"otherAbove10":[],"lockTicks":0,"label":"quiet"}.


### Session s3: contamination and load

Rows 2820, errors 0, wrong outputs 0, flagged 0 (none), over 50x the arm median 0.
Sampler: {"ticks":265,"loadMax":2.31,"busyMax":29.1,"otherAbove10":[],"lockTicks":0,"label":"quiet"}.


### Per-arm figures (x86_64)

| Arm | Set | Geomean | 95% (drivers) | P(>= 1.20) | Min | p10 | Slowest five | Gate 1 | Gate 2 |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- |
| w1 | s1 | 0.896 | 0.851 to 0.936 | 0.00 | 0.524 | 0.678 | mpack-mpack_writer_track_push 0.524; mpack-mpack_writer_track_bytes 0.536; nanopb-pb_istream_from_buffer 0.668; mpack-mpack_write_object_bytes 0.668; mpack-mpack_write_bytes 0.678 | NOT MET | NOT MET |
| w1 | s2 | 0.894 | 0.850 to 0.934 | 0.00 | 0.532 | 0.680 | mpack-mpack_writer_track_push 0.532; mpack-mpack_writer_track_bytes 0.544; nanopb-pb_istream_from_buffer 0.653; mpack-mpack_write_object_bytes 0.659; mpack-mpack_write_bytes 0.680 | NOT MET | NOT MET |
| w1 | s3 | 0.895 | 0.851 to 0.935 | 0.00 | 0.527 | 0.659 | mpack-mpack_writer_track_push 0.527; mpack-mpack_writer_track_bytes 0.544; nanopb-pb_istream_from_buffer 0.653; mpack-mpack_write_bin 0.657; mpack-mpack_write_object_bytes 0.659 | NOT MET | NOT MET |
| w1 | pooled | 0.895 | 0.851 to 0.935 | 0.00 | 0.527 | 0.681 | mpack-mpack_writer_track_push 0.527; mpack-mpack_writer_track_bytes 0.544; nanopb-pb_istream_from_buffer 0.657; mpack-mpack_write_object_bytes 0.660; mpack-mpack_write_bytes 0.681 | NOT MET | NOT MET |
| w2 | s1 | 0.908 | 0.869 to 0.942 | 0.00 | 0.560 | 0.729 | mpack-mpack_writer_track_push 0.560; mpack-mpack_writer_track_bytes 0.595; mpack-mpack_write_bytes 0.696; nanopb-pb_istream_from_buffer 0.702; nanopb-pb_ostream_from_buffer 0.729 | NOT MET | NOT MET |
| w2 | s2 | 0.909 | 0.872 to 0.943 | 0.00 | 0.579 | 0.723 | mpack-mpack_writer_track_push 0.579; mpack-mpack_writer_track_bytes 0.608; nanopb-pb_istream_from_buffer 0.681; mpack-mpack_write_bytes 0.722; mpack-mpack_write_object_bytes 0.723 | NOT MET | NOT MET |
| w2 | s3 | 0.912 | 0.875 to 0.946 | 0.00 | 0.595 | 0.724 | mpack-mpack_writer_track_bytes 0.595; mpack-mpack_writer_track_push 0.602; nanopb-pb_istream_from_buffer 0.681; mpack-mpack_write_bytes 0.722; mpack-mpack_write_object_bytes 0.724 | NOT MET | NOT MET |
| w2 | pooled | 0.910 | 0.873 to 0.943 | 0.00 | 0.591 | 0.725 | mpack-mpack_writer_track_push 0.591; mpack-mpack_writer_track_bytes 0.599; nanopb-pb_istream_from_buffer 0.683; mpack-mpack_write_bytes 0.717; mpack-mpack_write_object_bytes 0.725 | NOT MET | NOT MET |
| independent | s1 | 0.908 | 0.869 to 0.944 | 0.00 | 0.582 | 0.726 | mpack-mpack_writer_track_push 0.582; mpack-mpack_writer_track_bytes 0.602; nanopb-pb_istream_from_buffer 0.686; mpack-mpack_write_utf8 0.687; mpack-mpack_write_bin 0.726 | NOT MET | NOT MET |
| independent | s2 | 0.907 | 0.869 to 0.942 | 0.00 | 0.600 | 0.713 | mpack-mpack_writer_track_push 0.600; mpack-mpack_writer_track_bytes 0.604; nanopb-pb_istream_from_buffer 0.672; mpack-mpack_write_utf8 0.678; mpack-mpack_write_object_bytes 0.713 | NOT MET | NOT MET |
| independent | s3 | 0.908 | 0.870 to 0.943 | 0.00 | 0.592 | 0.731 | mpack-mpack_writer_track_push 0.592; mpack-mpack_writer_track_bytes 0.592; nanopb-pb_istream_from_buffer 0.684; mpack-mpack_write_utf8 0.703; mpack-mpack_write_bytes 0.731 | NOT MET | NOT MET |
| independent | pooled | 0.908 | 0.870 to 0.944 | 0.00 | 0.594 | 0.729 | mpack-mpack_writer_track_push 0.594; mpack-mpack_writer_track_bytes 0.596; nanopb-pb_istream_from_buffer 0.678; mpack-mpack_write_utf8 0.690; mpack-mpack_write_object_bytes 0.729 | NOT MET | NOT MET |
| shared | s1 | 0.857 | 0.806 to 0.906 | 0.00 | 0.502 | 0.624 | base64-base64_stream_decode 0.502; base64-base64_decode 0.506; mpack-mpack_writer_track_bytes 0.532; mpack-mpack_writer_track_push 0.550; nanopb-pb_istream_from_buffer 0.624 | NOT MET | NOT MET |
| shared | s2 | 0.857 | 0.806 to 0.906 | 0.00 | 0.504 | 0.601 | base64-base64_decode 0.504; base64-base64_stream_decode 0.505; mpack-mpack_writer_track_bytes 0.530; mpack-mpack_writer_track_push 0.545; nanopb-pb_istream_from_buffer 0.601 | NOT MET | NOT MET |
| shared | s3 | 0.856 | 0.805 to 0.906 | 0.00 | 0.500 | 0.650 | base64-base64_stream_decode 0.500; base64-base64_decode 0.505; mpack-mpack_writer_track_bytes 0.510; mpack-mpack_writer_track_push 0.548; mpack-mpack_write_object_bytes 0.650 | NOT MET | NOT MET |
| shared | pooled | 0.857 | 0.806 to 0.906 | 0.00 | 0.502 | 0.624 | base64-base64_stream_decode 0.502; base64-base64_decode 0.505; mpack-mpack_writer_track_bytes 0.526; mpack-mpack_writer_track_push 0.548; nanopb-pb_istream_from_buffer 0.624 | NOT MET | NOT MET |
| router | s1 | 0.897 | 0.859 to 0.933 | 0.00 | 0.597 | 0.716 | mpack-mpack_writer_track_push 0.597; mpack-mpack_writer_track_bytes 0.597; nanopb-pb_istream_from_buffer 0.683; nanopb-pb_ostream_from_buffer 0.708; ryu-f2s_buffered_n 0.716 | NOT MET | NOT MET |
| router | s2 | 0.900 | 0.861 to 0.936 | 0.00 | 0.577 | 0.718 | mpack-mpack_writer_track_push 0.577; mpack-mpack_writer_track_bytes 0.604; nanopb-pb_istream_from_buffer 0.677; mpack-mpack_write_utf8 0.701; mpack-mpack_write_object_bytes 0.718 | NOT MET | NOT MET |
| router | s3 | 0.900 | 0.861 to 0.936 | 0.00 | 0.593 | 0.719 | mpack-mpack_writer_track_bytes 0.593; mpack-mpack_writer_track_push 0.598; mpack-mpack_write_utf8 0.685; nanopb-pb_istream_from_buffer 0.685; mpack-mpack_write_bytes 0.719 | NOT MET | NOT MET |
| router | pooled | 0.899 | 0.861 to 0.935 | 0.00 | 0.594 | 0.722 | mpack-mpack_writer_track_push 0.594; mpack-mpack_writer_track_bytes 0.598; nanopb-pb_istream_from_buffer 0.682; mpack-mpack_write_utf8 0.694; mpack-mpack_write_bytes 0.722 | NOT MET | NOT MET |

### Router per driver, pooled (x86_64), sorted by speedup

| Driver | Project | Speedup | 95% of rounds | Min to max | Serial ms | Router ms |
| --- | --- | ---: | --- | --- | ---: | ---: |
| mpack-mpack_writer_track_push | mpack | 0.594 | 0.579 to 0.605 | 0.457 to 0.640 | 0.002 | 0.004 |
| mpack-mpack_writer_track_bytes | mpack | 0.598 | 0.584 to 0.609 | 0.322 to 0.640 | 0.003 | 0.004 |
| nanopb-pb_istream_from_buffer | nanopb | 0.682 | 0.676 to 0.686 | 0.509 to 0.963 | 0.004 | 0.005 |
| mpack-mpack_write_utf8 | mpack | 0.694 | 0.678 to 0.729 | 0.558 to 1.340 | 0.005 | 0.008 |
| mpack-mpack_write_bytes | mpack | 0.722 | 0.711 to 0.732 | 0.455 to 1.429 | 0.004 | 0.006 |
| ryu-f2s_buffered_n | ryu | 0.725 | 0.718 to 0.731 | 0.693 to 0.775 | 0.008 | 0.011 |
| mpack-mpack_write_object_bytes | mpack | 0.730 | 0.712 to 0.736 | 0.564 to 0.774 | 0.004 | 0.006 |
| nanopb-pb_ostream_from_buffer | nanopb | 0.740 | 0.729 to 0.747 | 0.392 to 0.774 | 0.005 | 0.006 |
| mpack-mpack_write_bin | mpack | 0.747 | 0.737 to 0.754 | 0.423 to 1.159 | 0.005 | 0.006 |
| tinycbor-cbor_encoder_init | tinycbor | 0.751 | 0.742 to 0.758 | 0.671 to 0.807 | 0.005 | 0.006 |
| ryu-f2s_buffered | ryu | 0.770 | 0.764 to 0.774 | 0.729 to 0.797 | 0.010 | 0.013 |
| ryu-d2s_buffered_n | ryu | 0.832 | 0.818 to 0.846 | 0.798 to 1.162 | 0.014 | 0.017 |
| ryu-d2s_buffered | ryu | 0.883 | 0.863 to 0.894 | 0.432 to 1.250 | 0.018 | 0.020 |
| tinycbor-cbor_encode_raw | tinycbor | 0.925 | 0.920 to 0.929 | 0.751 to 0.954 | 0.022 | 0.024 |
| tinycbor-cbor_encoder_create_map | tinycbor | 0.925 | 0.908 to 0.936 | 0.748 to 1.084 | 0.021 | 0.022 |
| nanopb-pb_write | nanopb | 0.927 | 0.923 to 0.935 | 0.818 to 1.133 | 0.022 | 0.024 |
| nanopb-pb_read | nanopb | 0.929 | 0.925 to 0.934 | 0.773 to 0.961 | 0.022 | 0.024 |
| nanopb-pb_encode_string | nanopb | 0.933 | 0.926 to 0.939 | 0.834 to 1.088 | 0.024 | 0.026 |
| tinycbor-cbor_encode_text_string | tinycbor | 0.937 | 0.931 to 0.939 | 0.735 to 1.793 | 0.030 | 0.032 |
| tinycbor-cbor_encode_byte_string | tinycbor | 0.938 | 0.932 to 0.942 | 0.880 to 1.217 | 0.030 | 0.032 |
| tinycbor-cbor_parser_init | tinycbor | 0.942 | 0.939 to 0.948 | 0.565 to 0.981 | 0.038 | 0.040 |
| stb-stbds_hmdel_key | stb | 0.957 | 0.952 to 0.962 | 0.905 to 1.408 | 0.081 | 0.084 |
| base64-base64_stream_decode | base64 | 0.958 | 0.954 to 0.965 | 0.676 to 0.998 | 0.060 | 0.063 |
| stb-stbds_hmput_key | stb | 0.962 | 0.958 to 0.973 | 0.876 to 1.395 | 0.074 | 0.077 |
| base64-base64_decode | base64 | 0.965 | 0.959 to 0.971 | 0.885 to 1.614 | 0.060 | 0.062 |
| stb-stbds_hmfree_func | stb | 0.968 | 0.955 to 0.974 | 0.849 to 1.383 | 0.076 | 0.079 |
| stb-stbds_hmget_key_ts | stb | 0.971 | 0.965 to 0.976 | 0.922 to 1.475 | 0.077 | 0.080 |
| libdeflate-libdeflate_deflate_compress | libdeflate | 0.973 | 0.916 to 0.993 | 0.872 to 1.067 | 0.858 | 0.896 |
| pcre2-pcre2_regerror | pcre2 | 0.980 | 0.977 to 0.989 | 0.586 to 1.679 | 0.141 | 0.143 |
| libdeflate-libdeflate_gzip_decompress_ex | libdeflate | 0.984 | 0.979 to 0.996 | 0.653 to 1.096 | 0.273 | 0.277 |
| libdeflate-libdeflate_gzip_decompress | libdeflate | 0.984 | 0.977 to 0.997 | 0.775 to 1.102 | 0.272 | 0.276 |
| minimp3-mp3dec_init | minimp3 | 0.987 | 0.982 to 0.991 | 0.957 to 1.008 | 1.129 | 1.142 |
| stb-stbi_load_gif_from_memory | stb | 0.988 | 0.986 to 0.990 | 0.760 to 1.000 | 0.502 | 0.508 |
| stb-stb_c_lexer_init | stb | 0.989 | 0.978 to 1.001 | 0.552 to 1.755 | 0.108 | 0.108 |
| cjson-cJSON_CreateStringArray | cjson | 0.992 | 0.981 to 0.997 | 0.631 to 1.462 | 0.109 | 0.110 |
| pcre2-pcre2_regexec | pcre2 | 0.994 | 0.974 to 1.027 | 0.928 to 1.969 | 0.103 | 0.105 |
| libdeflate-libdeflate_zlib_decompress | libdeflate | 0.994 | 0.990 to 1.002 | 0.899 to 1.254 | 0.277 | 0.278 |
| cjson-cJSON_CreateDoubleArray | cjson | 0.995 | 0.985 to 1.002 | 0.849 to 1.019 | 0.876 | 0.881 |
| cjson-cJSON_CreateFloatArray | cjson | 0.998 | 0.989 to 1.000 | 0.962 to 1.280 | 0.882 | 0.886 |
| libdeflate-libdeflate_gzip_compress_bound | libdeflate | 0.999 | 0.995 to 1.028 | 0.939 to 1.619 | 0.201 | 0.201 |
| libdeflate-libdeflate_zlib_compress_bound | libdeflate | 0.999 | 0.987 to 1.045 | 0.673 to 1.604 | 0.200 | 0.202 |
| minimp3-mp3dec_decode_frame | minimp3 | 1.001 | 0.994 to 1.003 | 0.709 to 1.060 | 1.237 | 1.236 |
| cjson-cJSON_ParseWithLengthOpts | cjson | 1.006 | 0.989 to 1.037 | 0.543 to 1.844 | 0.224 | 0.223 |
| cjson-cJSON_ParseWithLength | cjson | 1.009 | 0.983 to 1.042 | 0.622 to 1.520 | 0.218 | 0.216 |
| cjson-cJSON_CreateIntArray | cjson | 1.012 | 1.000 to 1.027 | 0.685 to 1.178 | 0.389 | 0.387 |
| base64-base64_stream_encode | base64 | 1.049 | 1.015 to 1.057 | 0.866 to 1.436 | 0.161 | 0.153 |
| base64-base64_encode | base64 | 1.049 | 1.032 to 1.072 | 0.808 to 1.361 | 0.163 | 0.155 |

Slowdowns (pooled router speedup below 1.00): 41.

- mpack-mpack_writer_track_push: 0.594 (95% 0.579 to 0.605, interval wholly below 1.00)
- mpack-mpack_writer_track_bytes: 0.598 (95% 0.584 to 0.609, interval wholly below 1.00)
- nanopb-pb_istream_from_buffer: 0.682 (95% 0.676 to 0.686, interval wholly below 1.00)
- mpack-mpack_write_utf8: 0.694 (95% 0.678 to 0.729, interval wholly below 1.00)
- mpack-mpack_write_bytes: 0.722 (95% 0.711 to 0.732, interval wholly below 1.00)
- ryu-f2s_buffered_n: 0.725 (95% 0.718 to 0.731, interval wholly below 1.00)
- mpack-mpack_write_object_bytes: 0.730 (95% 0.712 to 0.736, interval wholly below 1.00)
- nanopb-pb_ostream_from_buffer: 0.740 (95% 0.729 to 0.747, interval wholly below 1.00)
- mpack-mpack_write_bin: 0.747 (95% 0.737 to 0.754, interval wholly below 1.00)
- tinycbor-cbor_encoder_init: 0.751 (95% 0.742 to 0.758, interval wholly below 1.00)
- ryu-f2s_buffered: 0.770 (95% 0.764 to 0.774, interval wholly below 1.00)
- ryu-d2s_buffered_n: 0.832 (95% 0.818 to 0.846, interval wholly below 1.00)
- ryu-d2s_buffered: 0.883 (95% 0.863 to 0.894, interval wholly below 1.00)
- tinycbor-cbor_encode_raw: 0.925 (95% 0.920 to 0.929, interval wholly below 1.00)
- tinycbor-cbor_encoder_create_map: 0.925 (95% 0.908 to 0.936, interval wholly below 1.00)
- nanopb-pb_write: 0.927 (95% 0.923 to 0.935, interval wholly below 1.00)
- nanopb-pb_read: 0.929 (95% 0.925 to 0.934, interval wholly below 1.00)
- nanopb-pb_encode_string: 0.933 (95% 0.926 to 0.939, interval wholly below 1.00)
- tinycbor-cbor_encode_text_string: 0.937 (95% 0.931 to 0.939, interval wholly below 1.00)
- tinycbor-cbor_encode_byte_string: 0.938 (95% 0.932 to 0.942, interval wholly below 1.00)
- tinycbor-cbor_parser_init: 0.942 (95% 0.939 to 0.948, interval wholly below 1.00)
- stb-stbds_hmdel_key: 0.957 (95% 0.952 to 0.962, interval wholly below 1.00)
- base64-base64_stream_decode: 0.958 (95% 0.954 to 0.965, interval wholly below 1.00)
- stb-stbds_hmput_key: 0.962 (95% 0.958 to 0.973, interval wholly below 1.00)
- base64-base64_decode: 0.965 (95% 0.959 to 0.971, interval wholly below 1.00)
- stb-stbds_hmfree_func: 0.968 (95% 0.955 to 0.974, interval wholly below 1.00)
- stb-stbds_hmget_key_ts: 0.971 (95% 0.965 to 0.976, interval wholly below 1.00)
- libdeflate-libdeflate_deflate_compress: 0.973 (95% 0.916 to 0.993, interval wholly below 1.00)
- pcre2-pcre2_regerror: 0.980 (95% 0.977 to 0.989, interval wholly below 1.00)
- libdeflate-libdeflate_gzip_decompress_ex: 0.984 (95% 0.979 to 0.996, interval wholly below 1.00)
- libdeflate-libdeflate_gzip_decompress: 0.984 (95% 0.977 to 0.997, interval wholly below 1.00)
- minimp3-mp3dec_init: 0.987 (95% 0.982 to 0.991, interval wholly below 1.00)
- stb-stbi_load_gif_from_memory: 0.988 (95% 0.986 to 0.990, interval wholly below 1.00)
- stb-stb_c_lexer_init: 0.989 (95% 0.978 to 1.001)
- cjson-cJSON_CreateStringArray: 0.992 (95% 0.981 to 0.997, interval wholly below 1.00)
- pcre2-pcre2_regexec: 0.994 (95% 0.974 to 1.027)
- libdeflate-libdeflate_zlib_decompress: 0.994 (95% 0.990 to 1.002)
- cjson-cJSON_CreateDoubleArray: 0.995 (95% 0.985 to 1.002)
- cjson-cJSON_CreateFloatArray: 0.998 (95% 0.989 to 1.000, interval wholly below 1.00)
- libdeflate-libdeflate_gzip_compress_bound: 0.999 (95% 0.995 to 1.028)
- libdeflate-libdeflate_zlib_compress_bound: 0.999 (95% 0.987 to 1.045)

W3 readings, router, pooled (x86_64): geomean 0.899; without base64-base64_encode 0.896; without base64-base64_encode and base64-base64_stream_encode 0.893.

| Project | Drivers | Geomean | Min |
| --- | ---: | ---: | ---: |
| base64 | 4 | 1.004 | 0.958 |
| cjson | 6 | 1.002 | 0.992 |
| libdeflate | 6 | 0.989 | 0.973 |
| minimp3 | 2 | 0.994 | 0.987 |
| mpack | 6 | 0.678 | 0.594 |
| nanopb | 5 | 0.835 | 0.682 |
| pcre2 | 2 | 0.987 | 0.980 |
| ryu | 4 | 0.800 | 0.725 |
| stb | 6 | 0.973 | 0.957 |
| tinycbor | 6 | 0.900 | 0.751 |

### Routes, reasons and certificates per arm (x86_64, all sessions)

| Arm | Rows | Routes of rows | Modal route per driver | Certificate per driver | Reasons of rows |
| --- | ---: | --- | --- | --- | --- |
| serial | 1410 | serial 1410 | serial 47 | - 47 | baseline 1410 |
| w1 | 1410 | serial 1410 | serial 47 | none 47 | no-route-in-mode 1410 |
| w2 | 1410 | serial 1409, window 1 | serial 47 | none 46, window 1 | unclassified-dependency 690, allocator-state 570, no-certificate 120, dispatch-lost 29, certified-window 1 |
| independent | 1410 | serial 1410 | serial 47 | none 46, window 1 | unclassified-dependency 690, allocator-state 570, no-certificate 120, dispatch-lost 30 |
| shared | 1410 | serial 1410 | serial 47 | none 46, window 1 | unclassified-dependency 690, allocator-state 570, no-certificate 120, dispatch-lost 30 |
| router | 1410 | serial 1410 | serial 47 | none 46, window 1 | below-floor 690, unclassified-dependency 690, dispatch-lost 30 |

Cost per arm, median of rows in ms (certify, setup, open, prepare, first run, probe):

- serial: certifyMs NA, setupMs NA, openMs 1.59, prepareMs NA, firstRunMs 0.23, probeMs NA
- w1: certifyMs 0.00, setupMs 0.25, openMs 1.14, prepareMs 0.07, firstRunMs 0.35, probeMs NA
- w2: certifyMs 0.00, setupMs 0.25, openMs 1.50, prepareMs 0.07, firstRunMs 0.34, probeMs NA
- independent: certifyMs 0.00, setupMs 0.25, openMs 1.51, prepareMs 0.07, firstRunMs 0.34, probeMs NA
- shared: certifyMs 7.28, setupMs 0.36, openMs 8.89, prepareMs 0.08, firstRunMs 0.36, probeMs NA
- router: certifyMs 0.00, setupMs 60.15, openMs 61.37, prepareMs 0.07, firstRunMs 0.34, probeMs NA

Router per driver (x86_64): route counts, reasons, certificate:

- base64-base64_decode: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- base64-base64_encode: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- base64-base64_stream_decode: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- base64-base64_stream_encode: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- cjson-cJSON_CreateDoubleArray: serial 30; below-floor 30; certificate none
- cjson-cJSON_CreateFloatArray: serial 30; below-floor 30; certificate none
- cjson-cJSON_CreateIntArray: serial 30; below-floor 30; certificate none
- cjson-cJSON_CreateStringArray: serial 30; below-floor 30; certificate none
- cjson-cJSON_ParseWithLength: serial 30; below-floor 30; certificate none
- cjson-cJSON_ParseWithLengthOpts: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_deflate_compress: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_gzip_compress_bound: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_gzip_decompress: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_gzip_decompress_ex: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_zlib_compress_bound: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_zlib_decompress: serial 30; below-floor 30; certificate none
- minimp3-mp3dec_decode_frame: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- minimp3-mp3dec_init: serial 30; dispatch-lost 30; certificate window
- mpack-mpack_write_bin: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- mpack-mpack_write_bytes: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- mpack-mpack_write_object_bytes: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- mpack-mpack_write_utf8: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- mpack-mpack_writer_track_bytes: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- mpack-mpack_writer_track_push: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- nanopb-pb_encode_string: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- nanopb-pb_istream_from_buffer: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- nanopb-pb_ostream_from_buffer: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- nanopb-pb_read: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- nanopb-pb_write: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- pcre2-pcre2_regerror: serial 30; below-floor 30; certificate none
- pcre2-pcre2_regexec: serial 30; below-floor 30; certificate none
- ryu-d2s_buffered: serial 30; below-floor 30; certificate none
- ryu-d2s_buffered_n: serial 30; below-floor 30; certificate none
- ryu-f2s_buffered: serial 30; below-floor 30; certificate none
- ryu-f2s_buffered_n: serial 30; below-floor 30; certificate none
- stb-stb_c_lexer_init: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- stb-stbds_hmdel_key: serial 30; below-floor 30; certificate none
- stb-stbds_hmfree_func: serial 30; below-floor 30; certificate none
- stb-stbds_hmget_key_ts: serial 30; below-floor 30; certificate none
- stb-stbds_hmput_key: serial 30; below-floor 30; certificate none
- stb-stbi_load_gif_from_memory: serial 30; below-floor 30; certificate none
- tinycbor-cbor_encode_byte_string: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- tinycbor-cbor_encode_raw: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- tinycbor-cbor_encode_text_string: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- tinycbor-cbor_encoder_create_map: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- tinycbor-cbor_encoder_init: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- tinycbor-cbor_parser_init: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency

### Certify stage (x86_64)

| Mode | Certificates | Refusal reasons | Certify ms median per driver | Certify ms total | Cache hits | Unstable drivers |
| --- | --- | --- | ---: | ---: | ---: | --- |
| independent | none 46, window 1 | unclassified-dependency 23, allocator-state 19, no-certificate 4, certified-window 1 | 22.33 | 14365.84 | 0 | none |
| shared | none 46, window 1 | unclassified-dependency 23, allocator-state 19, no-certificate 4, certified-window 1 | 24.60 | 14488.22 | 0 | none |
| router (persistent cache) | none 46, window 1 | tracked-eligible 23, unclassified-dependency 23, certified-window 1 | 22.49 | 14467.13 | 1 | none |

### Verdict (x86_64)

- Gate 1 (geomean at least 1.20) by session NOT MET, NOT MET, NOT MET; architecture NOT MET.
- Gate 2 (every one of the slowest five at least 0.90) by session NOT MET, NOT MET, NOT MET; architecture NOT MET.
- Gate 3 (zero wrong outputs): wrong 0, error rows 0; MET.
- Median of the session values: geomean 0.900, min 0.593.

## Architecture arm64

Correctness pass: 282 rows, wrong outputs 0, errors 0, serial mismatches 0.

| Session | Span (UTC) | Rows | Errors | Wrong | Flagged | Over 50x median | Load label | Router geomean | Min | p10 (harness) | Gate 1 | Gate 2 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
| s1 | 20:21 to 20:39 | 2820 | 0 | 0 | 0 | 0 | loaded | 0.894 | 0.568 | 0.697 | NOT MET | NOT MET |
| s2 | 20:53 to 21:11 | 2820 | 0 | 0 | 189 | 0 | loaded | 0.906 | 0.549 | 0.719 | NOT MET | NOT MET |
| s3 | 21:25 to 21:44 | 2820 | 0 | 0 | 90 | 1 | loaded | 0.898 | 0.538 | 0.725 | NOT MET | NOT MET |
| pooled 30 rounds | | | | | | | | 0.900 | 0.561 | 0.715 | NOT MET | NOT MET |

### Session s1: contamination and load

Rows 2820, errors 0, wrong outputs 0, flagged 0 (none), over 50x the arm median 0.
Sampler: {"ticks":547,"loadMax":9.73,"loadMedian":5.35,"nonLaneMaxCpu":null,"nonLaneStartEnd":[null,41.8],"label":"loaded"}.


### Session s2: contamination and load

Rows 2820, errors 0, wrong outputs 0, flagged 189 (load-12 189), over 50x the arm median 0.
Sampler: {"ticks":539,"loadMax":22.74,"loadMedian":6.04,"nonLaneMaxCpu":null,"nonLaneStartEnd":[null,91],"label":"loaded"}.


### Session s3: contamination and load

Rows 2820, errors 0, wrong outputs 0, flagged 90 (load-12 90), over 50x the arm median 1; router geomean without them 0.898, min 0.538.
Sampler: {"ticks":535,"loadMax":13.67,"loadMedian":4.45,"nonLaneMaxCpu":null,"nonLaneStartEnd":[null,null],"label":"loaded"}.

Over 50x: mpack-mpack_write_bytes w2 round 8 1.22 ms

### Per-arm figures (arm64)

| Arm | Set | Geomean | 95% (drivers) | P(>= 1.20) | Min | p10 | Slowest five | Gate 1 | Gate 2 |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- |
| w1 | s1 | 0.905 | 0.864 to 0.943 | 0.00 | 0.556 | 0.715 | mpack-mpack_writer_track_push 0.556; mpack-mpack_writer_track_bytes 0.590; nanopb-pb_istream_from_buffer 0.612; mpack-mpack_write_object_bytes 0.711; mpack-mpack_write_bytes 0.715 | NOT MET | NOT MET |
| w1 | s2 | 0.905 | 0.863 to 0.943 | 0.00 | 0.556 | 0.707 | mpack-mpack_writer_track_push 0.556; mpack-mpack_writer_track_bytes 0.579; nanopb-pb_istream_from_buffer 0.591; nanopb-pb_ostream_from_buffer 0.692; tinycbor-cbor_encoder_init 0.707 | NOT MET | NOT MET |
| w1 | s3 | 0.905 | 0.864 to 0.943 | 0.00 | 0.559 | 0.705 | mpack-mpack_writer_track_bytes 0.559; mpack-mpack_writer_track_push 0.573; nanopb-pb_istream_from_buffer 0.637; nanopb-pb_ostream_from_buffer 0.695; mpack-mpack_write_bytes 0.705 | NOT MET | NOT MET |
| w1 | pooled | 0.905 | 0.865 to 0.943 | 0.00 | 0.559 | 0.713 | mpack-mpack_writer_track_push 0.559; mpack-mpack_writer_track_bytes 0.577; nanopb-pb_istream_from_buffer 0.610; nanopb-pb_ostream_from_buffer 0.700; mpack-mpack_write_bytes 0.713 | NOT MET | NOT MET |
| w2 | s1 | 0.906 | 0.866 to 0.942 | 0.00 | 0.569 | 0.726 | mpack-mpack_writer_track_bytes 0.569; mpack-mpack_writer_track_push 0.576; nanopb-pb_istream_from_buffer 0.632; mpack-mpack_write_bytes 0.721; mpack-mpack_write_object_bytes 0.726 | NOT MET | NOT MET |
| w2 | s2 | 0.904 | 0.866 to 0.939 | 0.00 | 0.584 | 0.730 | mpack-mpack_writer_track_bytes 0.584; mpack-mpack_writer_track_push 0.596; nanopb-pb_istream_from_buffer 0.632; nanopb-pb_ostream_from_buffer 0.704; mpack-mpack_write_bytes 0.730 | NOT MET | NOT MET |
| w2 | s3 | 0.902 | 0.862 to 0.939 | 0.00 | 0.551 | 0.722 | mpack-mpack_writer_track_push 0.551; mpack-mpack_writer_track_bytes 0.557; nanopb-pb_istream_from_buffer 0.658; nanopb-pb_ostream_from_buffer 0.709; mpack-mpack_write_bytes 0.722 | NOT MET | NOT MET |
| w2 | pooled | 0.902 | 0.863 to 0.939 | 0.00 | 0.567 | 0.723 | mpack-mpack_writer_track_push 0.567; mpack-mpack_writer_track_bytes 0.571; nanopb-pb_istream_from_buffer 0.637; nanopb-pb_ostream_from_buffer 0.711; mpack-mpack_write_bytes 0.723 | NOT MET | NOT MET |
| independent | s1 | 0.908 | 0.868 to 0.945 | 0.00 | 0.564 | 0.738 | mpack-mpack_writer_track_bytes 0.564; mpack-mpack_writer_track_push 0.573; nanopb-pb_istream_from_buffer 0.615; mpack-mpack_write_object_bytes 0.720; mpack-mpack_write_bin 0.738 | NOT MET | NOT MET |
| independent | s2 | 0.903 | 0.864 to 0.940 | 0.00 | 0.560 | 0.711 | mpack-mpack_writer_track_push 0.560; mpack-mpack_writer_track_bytes 0.585; nanopb-pb_istream_from_buffer 0.639; nanopb-pb_ostream_from_buffer 0.706; tinycbor-cbor_encoder_init 0.711 | NOT MET | NOT MET |
| independent | s3 | 0.901 | 0.862 to 0.936 | 0.00 | 0.551 | 0.716 | mpack-mpack_writer_track_push 0.551; mpack-mpack_writer_track_bytes 0.579; nanopb-pb_istream_from_buffer 0.659; nanopb-pb_ostream_from_buffer 0.711; mpack-mpack_write_object_bytes 0.716 | NOT MET | NOT MET |
| independent | pooled | 0.903 | 0.864 to 0.939 | 0.00 | 0.567 | 0.718 | mpack-mpack_writer_track_push 0.567; mpack-mpack_writer_track_bytes 0.578; nanopb-pb_istream_from_buffer 0.639; nanopb-pb_ostream_from_buffer 0.717; mpack-mpack_write_object_bytes 0.718 | NOT MET | NOT MET |
| shared | s1 | 0.876 | 0.822 to 0.928 | 0.00 | 0.452 | 0.610 | base64-base64_stream_decode 0.452; base64-base64_decode 0.455; mpack-mpack_writer_track_push 0.554; mpack-mpack_writer_track_bytes 0.571; nanopb-pb_istream_from_buffer 0.610 | NOT MET | NOT MET |
| shared | s2 | 0.876 | 0.822 to 0.928 | 0.00 | 0.458 | 0.602 | base64-base64_stream_decode 0.458; base64-base64_decode 0.469; mpack-mpack_writer_track_push 0.546; mpack-mpack_writer_track_bytes 0.547; nanopb-pb_istream_from_buffer 0.602 | NOT MET | NOT MET |
| shared | s3 | 0.874 | 0.820 to 0.925 | 0.00 | 0.443 | 0.610 | base64-base64_stream_decode 0.443; base64-base64_decode 0.463; mpack-mpack_writer_track_bytes 0.548; mpack-mpack_writer_track_push 0.561; nanopb-pb_istream_from_buffer 0.610 | NOT MET | NOT MET |
| shared | pooled | 0.875 | 0.821 to 0.926 | 0.00 | 0.453 | 0.608 | base64-base64_stream_decode 0.453; base64-base64_decode 0.461; mpack-mpack_writer_track_push 0.549; mpack-mpack_writer_track_bytes 0.557; nanopb-pb_istream_from_buffer 0.608 | NOT MET | NOT MET |
| router | s1 | 0.894 | 0.852 to 0.936 | 0.00 | 0.568 | 0.697 | mpack-mpack_writer_track_push 0.568; mpack-mpack_writer_track_bytes 0.569; nanopb-pb_istream_from_buffer 0.644; tinycbor-cbor_encoder_init 0.697; mpack-mpack_write_utf8 0.697 | NOT MET | NOT MET |
| router | s2 | 0.906 | 0.864 to 0.948 | 0.00 | 0.549 | 0.719 | mpack-mpack_writer_track_push 0.549; mpack-mpack_writer_track_bytes 0.565; nanopb-pb_istream_from_buffer 0.641; mpack-mpack_write_object_bytes 0.719; tinycbor-cbor_encoder_init 0.719 | NOT MET | NOT MET |
| router | s3 | 0.898 | 0.856 to 0.940 | 0.00 | 0.538 | 0.725 | mpack-mpack_writer_track_bytes 0.538; mpack-mpack_writer_track_push 0.556; nanopb-pb_istream_from_buffer 0.675; mpack-mpack_write_object_bytes 0.720; tinycbor-cbor_encoder_init 0.725 | NOT MET | NOT MET |
| router | pooled | 0.900 | 0.858 to 0.941 | 0.00 | 0.561 | 0.715 | mpack-mpack_writer_track_bytes 0.561; mpack-mpack_writer_track_push 0.566; nanopb-pb_istream_from_buffer 0.652; mpack-mpack_write_object_bytes 0.713; tinycbor-cbor_encoder_init 0.715 | NOT MET | NOT MET |

### Router per driver, pooled (arm64), sorted by speedup

| Driver | Project | Speedup | 95% of rounds | Min to max | Serial ms | Router ms |
| --- | --- | ---: | --- | --- | ---: | ---: |
| mpack-mpack_writer_track_bytes | mpack | 0.561 | 0.545 to 0.582 | 0.466 to 1.420 | 0.003 | 0.005 |
| mpack-mpack_writer_track_push | mpack | 0.566 | 0.544 to 0.571 | 0.484 to 0.670 | 0.003 | 0.005 |
| nanopb-pb_istream_from_buffer | nanopb | 0.652 | 0.640 to 0.670 | 0.537 to 0.789 | 0.004 | 0.006 |
| mpack-mpack_write_object_bytes | mpack | 0.713 | 0.706 to 0.736 | 0.488 to 0.779 | 0.006 | 0.008 |
| tinycbor-cbor_encoder_init | tinycbor | 0.715 | 0.701 to 0.750 | 0.126 to 0.870 | 0.006 | 0.008 |
| nanopb-pb_ostream_from_buffer | nanopb | 0.738 | 0.714 to 0.746 | 0.243 to 0.807 | 0.006 | 0.008 |
| mpack-mpack_write_bytes | mpack | 0.746 | 0.727 to 0.757 | 0.640 to 1.181 | 0.006 | 0.008 |
| mpack-mpack_write_bin | mpack | 0.748 | 0.731 to 0.777 | 0.656 to 2.108 | 0.007 | 0.009 |
| mpack-mpack_write_utf8 | mpack | 0.753 | 0.713 to 0.796 | 0.337 to 1.197 | 0.007 | 0.009 |
| ryu-f2s_buffered_n | ryu | 0.793 | 0.782 to 0.832 | 0.130 to 1.280 | 0.012 | 0.016 |
| ryu-f2s_buffered | ryu | 0.826 | 0.803 to 0.847 | 0.223 to 0.907 | 0.015 | 0.019 |
| cjson-cJSON_ParseWithLength | cjson | 0.828 | 0.802 to 0.839 | 0.103 to 0.964 | 0.285 | 0.347 |
| ryu-d2s_buffered_n | ryu | 0.829 | 0.813 to 0.841 | 0.687 to 0.906 | 0.017 | 0.021 |
| minimp3-mp3dec_init | minimp3 | 0.854 | 0.785 to 0.896 | 0.580 to 1.058 | 0.674 | 0.787 |
| cjson-cJSON_ParseWithLengthOpts | cjson | 0.860 | 0.843 to 0.881 | 0.520 to 1.311 | 0.283 | 0.332 |
| ryu-d2s_buffered | ryu | 0.873 | 0.848 to 0.893 | 0.782 to 1.017 | 0.022 | 0.025 |
| nanopb-pb_encode_string | nanopb | 0.918 | 0.883 to 0.954 | 0.661 to 1.164 | 0.048 | 0.051 |
| tinycbor-cbor_encoder_create_map | tinycbor | 0.922 | 0.899 to 0.937 | 0.704 to 1.120 | 0.024 | 0.026 |
| nanopb-pb_read | nanopb | 0.939 | 0.890 to 0.994 | 0.354 to 1.462 | 0.046 | 0.049 |
| libdeflate-libdeflate_deflate_compress | libdeflate | 0.940 | 0.878 to 0.978 | 0.747 to 1.624 | 1.109 | 1.193 |
| tinycbor-cbor_encode_raw | tinycbor | 0.941 | 0.890 to 0.963 | 0.370 to 1.060 | 0.046 | 0.051 |
| tinycbor-cbor_parser_init | tinycbor | 0.952 | 0.942 to 0.969 | 0.819 to 1.592 | 0.043 | 0.045 |
| tinycbor-cbor_encode_byte_string | tinycbor | 0.955 | 0.949 to 0.963 | 0.866 to 1.028 | 0.042 | 0.044 |
| nanopb-pb_write | nanopb | 0.959 | 0.927 to 1.013 | 0.546 to 1.254 | 0.048 | 0.048 |
| stb-stbds_hmget_key_ts | stb | 0.963 | 0.949 to 0.979 | 0.739 to 1.015 | 0.121 | 0.126 |
| stb-stbds_hmfree_func | stb | 0.964 | 0.941 to 0.972 | 0.598 to 2.367 | 0.119 | 0.123 |
| base64-base64_stream_decode | base64 | 0.964 | 0.946 to 0.977 | 0.462 to 2.629 | 0.075 | 0.077 |
| tinycbor-cbor_encode_text_string | tinycbor | 0.964 | 0.954 to 0.983 | 0.916 to 2.407 | 0.042 | 0.044 |
| cjson-cJSON_CreateFloatArray | cjson | 0.969 | 0.963 to 0.994 | 0.100 to 1.052 | 1.114 | 1.154 |
| stb-stbds_hmput_key | stb | 0.969 | 0.956 to 0.979 | 0.892 to 2.692 | 0.117 | 0.121 |
| base64-base64_decode | base64 | 0.972 | 0.950 to 0.987 | 0.711 to 1.186 | 0.074 | 0.076 |
| stb-stbds_hmdel_key | stb | 0.981 | 0.960 to 1.000 | 0.835 to 2.317 | 0.128 | 0.131 |
| stb-stbi_load_gif_from_memory | stb | 0.982 | 0.974 to 0.988 | 0.904 to 10.676 | 0.735 | 0.754 |
| stb-stb_c_lexer_init | stb | 0.986 | 0.949 to 0.999 | 0.620 to 1.158 | 0.158 | 0.160 |
| cjson-cJSON_CreateIntArray | cjson | 0.990 | 0.972 to 0.998 | 0.829 to 1.073 | 0.596 | 0.611 |
| pcre2-pcre2_regexec | pcre2 | 0.990 | 0.977 to 1.008 | 0.207 to 1.280 | 0.161 | 0.163 |
| base64-base64_stream_encode | base64 | 0.991 | 0.976 to 1.007 | 0.886 to 1.145 | 0.252 | 0.251 |
| base64-base64_encode | base64 | 0.992 | 0.974 to 1.006 | 0.574 to 1.086 | 0.248 | 0.251 |
| pcre2-pcre2_regerror | pcre2 | 0.992 | 0.987 to 1.004 | 0.596 to 1.253 | 0.212 | 0.214 |
| libdeflate-libdeflate_zlib_decompress | libdeflate | 0.994 | 0.984 to 1.009 | 0.686 to 1.129 | 0.409 | 0.407 |
| libdeflate-libdeflate_gzip_decompress_ex | libdeflate | 0.995 | 0.978 to 1.013 | 0.563 to 1.410 | 0.405 | 0.405 |
| cjson-cJSON_CreateDoubleArray | cjson | 0.997 | 0.982 to 1.017 | 0.922 to 2.887 | 1.137 | 1.135 |
| libdeflate-libdeflate_gzip_decompress | libdeflate | 1.001 | 0.986 to 1.022 | 0.700 to 1.471 | 0.406 | 0.401 |
| minimp3-mp3dec_decode_frame | minimp3 | 1.004 | 0.994 to 1.016 | 0.735 to 1.080 | 1.439 | 1.441 |
| cjson-cJSON_CreateStringArray | cjson | 1.202 | 1.181 to 1.226 | 1.089 to 1.571 | 0.118 | 0.099 |
| libdeflate-libdeflate_gzip_compress_bound | libdeflate | 1.203 | 1.166 to 1.269 | 0.970 to 1.501 | 0.278 | 0.224 |
| libdeflate-libdeflate_zlib_compress_bound | libdeflate | 1.220 | 1.200 to 1.258 | 0.983 to 3.684 | 0.272 | 0.225 |

Slowdowns (pooled router speedup below 1.00): 42.

- mpack-mpack_writer_track_bytes: 0.561 (95% 0.545 to 0.582, interval wholly below 1.00)
- mpack-mpack_writer_track_push: 0.566 (95% 0.544 to 0.571, interval wholly below 1.00)
- nanopb-pb_istream_from_buffer: 0.652 (95% 0.640 to 0.670, interval wholly below 1.00)
- mpack-mpack_write_object_bytes: 0.713 (95% 0.706 to 0.736, interval wholly below 1.00)
- tinycbor-cbor_encoder_init: 0.715 (95% 0.701 to 0.750, interval wholly below 1.00)
- nanopb-pb_ostream_from_buffer: 0.738 (95% 0.714 to 0.746, interval wholly below 1.00)
- mpack-mpack_write_bytes: 0.746 (95% 0.727 to 0.757, interval wholly below 1.00)
- mpack-mpack_write_bin: 0.748 (95% 0.731 to 0.777, interval wholly below 1.00)
- mpack-mpack_write_utf8: 0.753 (95% 0.713 to 0.796, interval wholly below 1.00)
- ryu-f2s_buffered_n: 0.793 (95% 0.782 to 0.832, interval wholly below 1.00)
- ryu-f2s_buffered: 0.826 (95% 0.803 to 0.847, interval wholly below 1.00)
- cjson-cJSON_ParseWithLength: 0.828 (95% 0.802 to 0.839, interval wholly below 1.00)
- ryu-d2s_buffered_n: 0.829 (95% 0.813 to 0.841, interval wholly below 1.00)
- minimp3-mp3dec_init: 0.854 (95% 0.785 to 0.896, interval wholly below 1.00)
- cjson-cJSON_ParseWithLengthOpts: 0.860 (95% 0.843 to 0.881, interval wholly below 1.00)
- ryu-d2s_buffered: 0.873 (95% 0.848 to 0.893, interval wholly below 1.00)
- nanopb-pb_encode_string: 0.918 (95% 0.883 to 0.954, interval wholly below 1.00)
- tinycbor-cbor_encoder_create_map: 0.922 (95% 0.899 to 0.937, interval wholly below 1.00)
- nanopb-pb_read: 0.939 (95% 0.890 to 0.994, interval wholly below 1.00)
- libdeflate-libdeflate_deflate_compress: 0.940 (95% 0.878 to 0.978, interval wholly below 1.00)
- tinycbor-cbor_encode_raw: 0.941 (95% 0.890 to 0.963, interval wholly below 1.00)
- tinycbor-cbor_parser_init: 0.952 (95% 0.942 to 0.969, interval wholly below 1.00)
- tinycbor-cbor_encode_byte_string: 0.955 (95% 0.949 to 0.963, interval wholly below 1.00)
- nanopb-pb_write: 0.959 (95% 0.927 to 1.013)
- stb-stbds_hmget_key_ts: 0.963 (95% 0.949 to 0.979, interval wholly below 1.00)
- stb-stbds_hmfree_func: 0.964 (95% 0.941 to 0.972, interval wholly below 1.00)
- base64-base64_stream_decode: 0.964 (95% 0.946 to 0.977, interval wholly below 1.00)
- tinycbor-cbor_encode_text_string: 0.964 (95% 0.954 to 0.983, interval wholly below 1.00)
- cjson-cJSON_CreateFloatArray: 0.969 (95% 0.963 to 0.994, interval wholly below 1.00)
- stb-stbds_hmput_key: 0.969 (95% 0.956 to 0.979, interval wholly below 1.00)
- base64-base64_decode: 0.972 (95% 0.950 to 0.987, interval wholly below 1.00)
- stb-stbds_hmdel_key: 0.981 (95% 0.960 to 1.000)
- stb-stbi_load_gif_from_memory: 0.982 (95% 0.974 to 0.988, interval wholly below 1.00)
- stb-stb_c_lexer_init: 0.986 (95% 0.949 to 0.999, interval wholly below 1.00)
- cjson-cJSON_CreateIntArray: 0.990 (95% 0.972 to 0.998, interval wholly below 1.00)
- pcre2-pcre2_regexec: 0.990 (95% 0.977 to 1.008)
- base64-base64_stream_encode: 0.991 (95% 0.976 to 1.007)
- base64-base64_encode: 0.992 (95% 0.974 to 1.006)
- pcre2-pcre2_regerror: 0.992 (95% 0.987 to 1.004)
- libdeflate-libdeflate_zlib_decompress: 0.994 (95% 0.984 to 1.009)
- libdeflate-libdeflate_gzip_decompress_ex: 0.995 (95% 0.978 to 1.013)
- cjson-cJSON_CreateDoubleArray: 0.997 (95% 0.982 to 1.017)

W3 readings, router, pooled (arm64): geomean 0.900; without libdeflate-libdeflate_zlib_compress_bound 0.894; without libdeflate-libdeflate_zlib_compress_bound and libdeflate-libdeflate_gzip_compress_bound 0.889.

| Project | Drivers | Geomean | Min |
| --- | ---: | ---: | ---: |
| base64 | 4 | 0.980 | 0.964 |
| cjson | 6 | 0.967 | 0.828 |
| libdeflate | 6 | 1.053 | 0.940 |
| minimp3 | 2 | 0.926 | 0.854 |
| mpack | 6 | 0.676 | 0.561 |
| nanopb | 5 | 0.832 | 0.652 |
| pcre2 | 2 | 0.991 | 0.990 |
| ryu | 4 | 0.830 | 0.793 |
| stb | 6 | 0.974 | 0.963 |
| tinycbor | 6 | 0.903 | 0.715 |

### Routes, reasons and certificates per arm (arm64, all sessions)

| Arm | Rows | Routes of rows | Modal route per driver | Certificate per driver | Reasons of rows |
| --- | ---: | --- | --- | --- | --- |
| serial | 1410 | serial 1410 | serial 47 | - 47 | baseline 1410 |
| w1 | 1410 | serial 1410 | serial 47 | none 47 | no-route-in-mode 1410 |
| w2 | 1410 | serial 1391, window 19 | serial 46, window 1 | none 46, window 1 | unclassified-dependency 690, allocator-state 570, no-certificate 120, certified-window 19, dispatch-lost 11 |
| independent | 1410 | serial 1390, window 20 | serial 46, window 1 | none 46, window 1 | unclassified-dependency 690, allocator-state 570, no-certificate 120, certified-window 20, dispatch-lost 10 |
| shared | 1410 | serial 1390, window 20 | serial 46, window 1 | none 46, window 1 | unclassified-dependency 690, allocator-state 570, no-certificate 120, certified-window 20, dispatch-lost 10 |
| router | 1410 | serial 1389, window 21 | serial 46, window 1 | none 46, window 1 | unclassified-dependency 690, below-floor 689, certified-window 21, dispatch-lost 10 |

Cost per arm, median of rows in ms (certify, setup, open, prepare, first run, probe):

- serial: certifyMs NA, setupMs NA, openMs 1.77, prepareMs NA, firstRunMs 0.35, probeMs NA
- w1: certifyMs 0.00, setupMs 0.26, openMs 1.24, prepareMs 0.09, firstRunMs 0.44, probeMs NA
- w2: certifyMs 0.00, setupMs 0.26, openMs 1.66, prepareMs 0.09, firstRunMs 0.44, probeMs NA
- independent: certifyMs 0.00, setupMs 0.27, openMs 1.66, prepareMs 0.09, firstRunMs 0.44, probeMs NA
- shared: certifyMs 10.54, setupMs 0.31, openMs 12.15, prepareMs 0.09, firstRunMs 0.44, probeMs NA
- router: certifyMs 0.00, setupMs 77.19, openMs 78.49, prepareMs 0.09, firstRunMs 0.46, probeMs NA

Router per driver (arm64): route counts, reasons, certificate:

- base64-base64_decode: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- base64-base64_encode: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- base64-base64_stream_decode: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- base64-base64_stream_encode: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- cjson-cJSON_CreateDoubleArray: serial 30; below-floor 29, dispatch-lost 1; certificate none
- cjson-cJSON_CreateFloatArray: serial 30; below-floor 30; certificate none
- cjson-cJSON_CreateIntArray: serial 30; below-floor 30; certificate none
- cjson-cJSON_CreateStringArray: serial 30; below-floor 30; certificate none
- cjson-cJSON_ParseWithLength: serial 30; below-floor 30; certificate none
- cjson-cJSON_ParseWithLengthOpts: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_deflate_compress: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_gzip_compress_bound: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_gzip_decompress: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_gzip_decompress_ex: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_zlib_compress_bound: serial 30; below-floor 30; certificate none
- libdeflate-libdeflate_zlib_decompress: serial 30; below-floor 30; certificate none
- minimp3-mp3dec_decode_frame: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- minimp3-mp3dec_init: window 21, serial 9; certified-window 21, dispatch-lost 9; certificate window
- mpack-mpack_write_bin: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- mpack-mpack_write_bytes: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- mpack-mpack_write_object_bytes: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- mpack-mpack_write_utf8: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- mpack-mpack_writer_track_bytes: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- mpack-mpack_writer_track_push: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- nanopb-pb_encode_string: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- nanopb-pb_istream_from_buffer: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- nanopb-pb_ostream_from_buffer: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- nanopb-pb_read: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- nanopb-pb_write: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- pcre2-pcre2_regerror: serial 30; below-floor 30; certificate none
- pcre2-pcre2_regexec: serial 30; below-floor 30; certificate none
- ryu-d2s_buffered: serial 30; below-floor 30; certificate none
- ryu-d2s_buffered_n: serial 30; below-floor 30; certificate none
- ryu-f2s_buffered: serial 30; below-floor 30; certificate none
- ryu-f2s_buffered_n: serial 30; below-floor 30; certificate none
- stb-stb_c_lexer_init: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- stb-stbds_hmdel_key: serial 30; below-floor 30; certificate none
- stb-stbds_hmfree_func: serial 30; below-floor 30; certificate none
- stb-stbds_hmget_key_ts: serial 30; below-floor 30; certificate none
- stb-stbds_hmput_key: serial 30; below-floor 30; certificate none
- stb-stbi_load_gif_from_memory: serial 30; below-floor 30; certificate none
- tinycbor-cbor_encode_byte_string: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- tinycbor-cbor_encode_raw: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- tinycbor-cbor_encode_text_string: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- tinycbor-cbor_encoder_create_map: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- tinycbor-cbor_encoder_init: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency
- tinycbor-cbor_parser_init: serial 30; unclassified-dependency 30; certificate none; refusal unclassified-dependency

### Certify stage (arm64)

| Mode | Certificates | Refusal reasons | Certify ms median per driver | Certify ms total | Cache hits | Unstable drivers |
| --- | --- | --- | ---: | ---: | ---: | --- |
| independent | none 46, window 1 | unclassified-dependency 23, allocator-state 19, no-certificate 4, certified-window 1 | 30.20 | 17711.98 | 0 | none |
| shared | none 46, window 1 | unclassified-dependency 23, allocator-state 19, no-certificate 4, certified-window 1 | 32.04 | 17821.59 | 0 | none |
| router (persistent cache) | none 46, window 1 | tracked-eligible 23, unclassified-dependency 23, certified-window 1 | 30.33 | 17706.96 | 1 | none |

### Verdict (arm64)

- Gate 1 (geomean at least 1.20) by session NOT MET, NOT MET, NOT MET; architecture NOT MET.
- Gate 2 (every one of the slowest five at least 0.90) by session NOT MET, NOT MET, NOT MET; architecture NOT MET.
- Gate 3 (zero wrong outputs): wrong 0, error rows 0; MET.
- Median of the session values: geomean 0.898, min 0.549.

## Overall

Complete (2 architectures, 3 sessions each): true. Gate 1 NOT MET, gate 2 NOT MET, gate 3 MET.


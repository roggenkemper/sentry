from typing import Any, Mapping, Optional, Set

from django.conf import settings
from google.cloud import spanner

from sentry.sentry_metrics.configuration import UseCaseKey
from sentry.sentry_metrics.indexer.base import KeyResult, KeyResults, StringIndexer
from sentry.sentry_metrics.indexer.cache import CachingIndexer, StringIndexerCache
from sentry.sentry_metrics.indexer.id_generator import reverse_bits
from sentry.sentry_metrics.indexer.strings import StaticStringIndexer
from sentry.utils.codecs import Codec

EncodedId = int
DecodedId = int

_PARTITION_KEY = "cs"

indexer_cache = StringIndexerCache(
    **settings.SENTRY_STRING_INDEXER_CACHE_OPTIONS, partition_key=_PARTITION_KEY
)


class IdCodec(Codec[DecodedId, EncodedId]):
    """
    Encodes 63 bit IDs generated by the id_generator so that they are well distributed for CloudSpanner.

    Given an ID, this codec does the following:
    - reverses the bits and shifts to the left by one
    - Subtract 2^63 so that that the unsigned 64 bit integer now fits in a signed 64 bit field
    """

    def encode(self, value: DecodedId) -> EncodedId:
        return reverse_bits(value, 64) - 2**63

    def decode(self, value: EncodedId) -> DecodedId:
        return reverse_bits(value + 2**63, 64)


class RawCloudSpannerIndexer(StringIndexer):
    """
    Provides integer IDs for metric names, tag keys and tag values
    and the corresponding reverse lookup.
    """

    def __init__(self, instance_id: str, database_id: str) -> None:
        self.instance_id = instance_id
        self.database_id = database_id
        spanner_client = spanner.Client()
        self.instance = spanner_client.instance(self.instance_id)
        self.database = self.instance.database(self.database_id)

    def validate(self) -> None:
        """
        Run a simple query to ensure the database is accessible.
        """
        with self.database.snapshot() as snapshot:
            try:
                snapshot.execute_sql("SELECT 1")
            except ValueError:
                # TODO: What is the correct way to handle connection errors?
                pass

    def bulk_record(
        self, use_case_id: UseCaseKey, org_strings: Mapping[int, Set[str]]
    ) -> KeyResults:
        # Currently just calls record() on each item. We may want to consider actually recording
        # in batches though.
        key_results = KeyResults()

        for (org_id, strings) in org_strings.items():
            for string in strings:
                result = self.record(use_case_id, org_id, string)
                key_results.add_key_result(KeyResult(org_id, string, result))

        return key_results

    def record(self, use_case_id: UseCaseKey, org_id: int, string: str) -> Optional[int]:
        raise NotImplementedError

    def resolve(self, use_case_id: UseCaseKey, org_id: int, string: str) -> Optional[int]:
        raise NotImplementedError

    def reverse_resolve(self, use_case_id: UseCaseKey, org_id: int, id: int) -> Optional[str]:
        raise NotImplementedError


class CloudSpannerIndexer(StaticStringIndexer):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(CachingIndexer(indexer_cache, RawCloudSpannerIndexer(**kwargs)))

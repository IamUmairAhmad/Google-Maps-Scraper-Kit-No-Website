import unittest

import io
import zipfile

from app.leads import (
    business_website,
    classify_result,
    classify_status,
    clickable_maps_url,
    count_results,
    csv_cell,
    filter_rows,
    has_website,
    keep_lead,
    result_filename,
    review_count_from_panel,
    rows_to_csv,
    rows_to_xlsx,
    with_result,
)

ROWS = [
    {"name": "A", "status": "active", "website": "", "maps_url": "https://www.google.com/maps/place/A"},
    {"name": "B", "status": "active", "website": "https://b.example", "maps_url": "https://www.google.com/maps/place/B"},
    {"name": "C", "status": "permanently closed", "website": "", "maps_url": "https://www.google.com/maps/place/C"},
    {"name": "D", "status": "temporarily closed", "website": "https://d.example", "maps_url": ""},
    {"name": "E", "status": "active", "website": "https://facebook.com/e", "maps_url": "https://www.google.com/maps/place/E"},
]


class LeadFilterTests(unittest.TestCase):
    def test_open_later_today_is_still_active(self):
        self.assertEqual(classify_status("Closed · Opens 9 AM"), "active")

    def test_closed_down_labels(self):
        self.assertEqual(classify_status("Permanently closed"), "permanently closed")
        self.assertEqual(classify_status("Temporarily closed"), "temporarily closed")

    def test_blank_website_values(self):
        self.assertFalse(has_website(""))
        self.assertFalse(has_website("  "))
        self.assertFalse(has_website("n/a"))
        self.assertTrue(has_website("https://example.com"))

    def test_profile_links_are_not_a_business_website(self):
        self.assertFalse(has_website("https://www.facebook.com/asliceofeden/menu/"))
        self.assertFalse(has_website("https://instagram.com/example"))
        self.assertEqual(business_website("https://www.facebook.com/asliceofeden/menu/"), "")
        self.assertEqual(
            business_website("https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F"),
            "https://example.com/",
        )

    def test_review_count_comes_from_the_place_header(self):
        panel = "Mount Dessert Bakery\n4.6\n(1,234)\nCafe\n(207) 801-9191"
        self.assertEqual(review_count_from_panel(panel), "1234")
        phone_first = "Place\n(207) 801-9191\n4.6\n(530)\n"
        self.assertEqual(review_count_from_panel(phone_first), "530")

    def test_keeps_only_active_listings_without_a_website(self):
        self.assertTrue(keep_lead({"status": "active", "website": ""}))
        self.assertFalse(keep_lead({"status": "active", "website": "https://example.com"}))
        self.assertFalse(keep_lead({"status": "permanently closed", "website": ""}))
        self.assertFalse(keep_lead({"status": "temporarily closed", "website": ""}))

    def test_csv_quotes_formula_cells_and_writes_the_lead_header(self):
        self.assertEqual(csv_cell("=cmd"), "'=cmd")
        text = rows_to_csv([
            {
                "name": "Ada Plumbing",
                "phone": "555-0100",
                "email": "",
                "website": "",
                "category": "Plumber",
                "address": "1 Main St",
                "rating": "4.8",
                "review_count": "12",
                "status": "active",
                "maps_url": "https://maps.example/place",
                "niche": "plumbers",
                "location": "Austin, TX",
            }
        ])
        self.assertTrue(text.startswith(
            "name,phone,email,website,category,address,rating,review_count,status,result,maps_url,niche,location\n"
        ))
        self.assertIn("Ada Plumbing", text)
        self.assertIn("Austin, TX", text)

    def test_every_listing_gets_one_result(self):
        self.assertEqual([classify_result(r) for r in ROWS],
                         ["No website", "Has website", "Closed", "Closed", "No website"])
        self.assertEqual(with_result(ROWS[0])["result"], "No website")

    def test_four_filters(self):
        names = lambda key: [r["name"] for r in filter_rows(ROWS, key)]
        self.assertEqual(names("checked"), ["A", "B", "C", "D", "E"])
        self.assertEqual(names("no_website"), ["A", "E"])
        self.assertEqual(names("has_website"), ["B"])
        self.assertEqual(names("closed"), ["C", "D"])
        with self.assertRaises(ValueError):
            filter_rows(ROWS, "other")

    def test_counts_add_up(self):
        counts = count_results(ROWS)
        self.assertEqual(counts, {"checked": 5, "found": 2, "skipped_website": 1, "skipped_closed": 2})

    def test_file_names_follow_the_filter(self):
        self.assertEqual(result_filename("no_website", "Plumbers", "Austin, TX"), "no-website-plumbers-austin-tx.csv")
        self.assertEqual(result_filename("checked", "a", "b", "xlsx"), "all-checked-a-b.xlsx")

    def test_long_maps_links_fall_back_to_a_short_cid_link(self):
        self.assertEqual(clickable_maps_url("javascript:alert(1)"), "")
        long_url = "https://www.google.com/maps/place/X/data=!1s0x89c:0xff!8m2" + "a" * 2100
        self.assertEqual(clickable_maps_url(long_url), "https://www.google.com/maps?cid=255")

    def test_excel_names_link_to_maps_and_never_become_formulas(self):
        try:
            from openpyxl import load_workbook
        except ImportError:
            self.skipTest("openpyxl is not installed")
        rows = [with_result(dict(ROWS[0], name="=HYPERLINK(\"http://evil\")")), with_result(ROWS[3])]
        data = rows_to_xlsx(rows)
        self.assertTrue(zipfile.is_zipfile(io.BytesIO(data)))
        sheet = load_workbook(io.BytesIO(data)).active
        self.assertEqual(sheet["A1"].value, "name")
        self.assertEqual(sheet["A2"].hyperlink.target, "https://www.google.com/maps/place/A")
        self.assertNotEqual(sheet["A2"].data_type, "f")
        self.assertIsNone(sheet["A3"].hyperlink)  # no Maps link for that row


if __name__ == "__main__":
    unittest.main()
